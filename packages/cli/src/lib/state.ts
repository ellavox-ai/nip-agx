import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_SEEN_RETENTION_SEC, type SeenStore } from "@nostr-agx/core";
import { z } from "zod";
import { seenPath, statePath, writePrivateJson } from "./paths.js";

/**
 * Durable poll state for `agx serve`.
 *
 * The transport re-delivers its whole poll window on every poll by design — the
 * 120-second overlap plus the two-day NIP-59 backdate lookback — so without a
 * persisted `SeenStore` a restart re-runs handlers for messages that were already
 * answered. And without a persisted cursor a restart re-drains the
 * whole inbox from zero. Both files are written atomically after each poll.
 */

const stateSchema = z.object({
	version: z.literal(1).default(1),
	/** Unix seconds. 0 means "drain everything". */
	cursor: z.number().default(0),
	lastPumpAt: z.string().nullable().default(null),
	advertisedAt: z.string().nullable().default(null),
	listingId: z.string().nullable().default(null),
	listingSlug: z.string().nullable().default(null),
	stats: z
		.object({
			received: z.number().default(0),
			replied: z.number().default(0),
			denied: z.number().default(0),
			tasks: z.number().default(0),
		})
		.default({ received: 0, replied: 0, denied: 0, tasks: 0 }),
});

export type AgxState = z.infer<typeof stateSchema>;

export function loadState(profile: string): AgxState {
	const path = statePath(profile);
	if (!existsSync(path)) {
		return stateSchema.parse({});
	}
	const parsed = stateSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	return parsed.success ? parsed.data : stateSchema.parse({});
}

export function saveState(profile: string, state: AgxState): void {
	writePrivateJson(statePath(profile), state);
}

export function updateState(
	profile: string,
	patch: Partial<AgxState>,
): AgxState {
	const next = { ...loadState(profile), ...patch };
	saveState(profile, next);
	return next;
}

const seenEntrySchema = z.object({ id: z.string(), seenAt: z.number() });

/** v2: each id with the time it was recorded, so retention is by age. */
const seenSchemaV2 = z.object({
	version: z.literal(2),
	entries: z.array(seenEntrySchema).default([]),
	failures: z.record(z.string(), z.number()).default({}),
});

/** v1 (count-bounded, no timestamps). Read once and upgraded on the next flush. */
const seenSchemaV1 = z.object({
	version: z.literal(1).default(1),
	ids: z.array(z.string()).default([]),
	failures: z.record(z.string(), z.number()).default({}),
});

/** Memory/disk guard only — retention is `DEFAULT_SEEN_RETENTION_SEC`, the same
 * time window as `InMemorySeenStore`'s. Evicting an id still inside the poll
 * window re-delivers it, so this sits far above what that window holds. */
const MAX_SEEN = 200_000;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * File-backed replay protection. Single-writer by construction — `agx serve`
 * takes a per-profile lock — which is what `SeenStore`'s check-then-act contract
 * requires. `hasMany` is implemented so a poll costs one lookup pass rather than
 * one per event.
 *
 * Ids are kept by AGE: the poll window is a time span (two days of NIP-59
 * backdate), and a count-bounded list evicted history that was still inside it —
 * each gift-wrapped event records two ids, and junk wraps take slots too.
 */
export class FileSeenStore implements SeenStore {
	private readonly path: string;
	/** id -> recorded-at (unix seconds); insertion order is time order. */
	private seenAt: Map<string, number>;
	private failures: Record<string, number>;
	private dirty = false;

	constructor(profile: string) {
		this.path = seenPath(profile);
		const raw: unknown = existsSync(this.path)
			? JSON.parse(readFileSync(this.path, "utf8"))
			: null;
		const v2 = seenSchemaV2.safeParse(raw);
		if (v2.success) {
			this.seenAt = new Map(v2.data.entries.map((e) => [e.id, e.seenAt]));
			this.failures = v2.data.failures;
			return;
		}
		const v1 = seenSchemaV1.safeParse(raw ?? {});
		const data = v1.success ? v1.data : seenSchemaV1.parse({});
		// v1 kept no timestamps: treat every id as recorded now, which keeps it
		// for a full retention window rather than risk re-delivering it.
		const loadedAt = nowSec();
		this.seenAt = new Map(data.ids.map((id) => [id, loadedAt]));
		this.failures = data.failures;
		this.dirty = data.ids.length > 0;
	}

	private live(id: string, now = nowSec()): boolean {
		const at = this.seenAt.get(id);
		return at !== undefined && at > now - DEFAULT_SEEN_RETENTION_SEC;
	}

	private prune(now: number): void {
		const cutoff = now - DEFAULT_SEEN_RETENTION_SEC;
		for (const [id, at] of this.seenAt) {
			if (at > cutoff && this.seenAt.size <= MAX_SEEN) {
				break;
			}
			this.seenAt.delete(id);
			this.dirty = true;
		}
	}

	has(id: string): boolean {
		return this.live(id);
	}

	hasMany(ids: string[]): Set<string> {
		const now = nowSec();
		const hits = new Set<string>();
		for (const id of ids) {
			if (this.live(id, now)) {
				hits.add(id);
			}
		}
		return hits;
	}

	add(id: string): void {
		const now = nowSec();
		if (!this.live(id, now)) {
			this.seenAt.delete(id);
			this.seenAt.set(id, now);
			this.dirty = true;
		}
		this.prune(now);
	}

	/** In-memory like `add`; the file is written once per poll by `flush()`. */
	addMany(ids: string[]): void {
		for (const id of ids) {
			this.add(id);
		}
	}

	recordFailure(id: string): number {
		const next = (this.failures[id] ?? 0) + 1;
		this.failures[id] = next;
		this.dirty = true;
		return next;
	}

	/** Persist only when something changed — a quiet poll writes nothing. */
	flush(): void {
		if (!this.dirty) {
			return;
		}
		writePrivateJson(this.path, {
			version: 2,
			entries: Array.from(this.seenAt, ([id, seenAt]) => ({
				id,
				seenAt,
			})),
			failures: this.failures,
		});
		this.dirty = false;
	}
}
