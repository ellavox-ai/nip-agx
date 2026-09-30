/**
 * Replay protection. Every inbound transport event has a unique id; processing
 * each at-most-once makes redelivery (overlapping poll windows, retries) safe.
 * Two-phase (`has` then `add`) so a caller records an id only AFTER it has been
 * processed successfully — a dispatch that throws leaves the id unseen and is
 * retried on the next poll (at-least-once). The host can plug a durable store (a
 * DB row); the default is in-memory. Either way an id must be kept for LONGER
 * THAN THE POLL WINDOW — a time span, the poll overlap plus the transport's
 * `pollLookbackSec` — or an evicted id still inside the window is re-delivered.
 *
 * CONCURRENCY (normative). `has`/`add` are check-then-act, not an atomic claim, so
 * `AgxClient`'s at-most-once dispatch guarantee holds ONLY under a SINGLE writer per
 * identity. A host that drives concurrent/overlapping pumps against a SHARED durable
 * store (e.g. N workers, or an ingest cron that can overlap itself) can have two
 * pumps both observe `has(id) === false` and both dispatch — degrading to
 * at-least-once. Such a host MUST serialize processing per identity (e.g. a
 * per-identity lease / advisory lock) OR make its dispatch side effects idempotent.
 * A future atomic-claim primitive could move this into the store, but the current
 * contract is deliberately single-writer to preserve the retry-on-failure semantics
 * above (an atomic claim-before-dispatch would flip failed dispatches to at-most-once).
 */
export interface SeenStore {
	/** Whether `id` was already processed. */
	has(id: string): boolean | Promise<boolean>;
	/** Which of `ids` were already processed. Optional batch form of {@link has}: a
	 * host backed by a DB can answer a whole poll's worth of ids in one round-trip
	 * instead of one `has` per event. `AgxClient` prefetches with this when present
	 * and falls back to per-id `has` otherwise. */
	hasMany?(ids: string[]): Set<string> | Promise<Set<string>>;
	/** Record `id` as processed. Idempotent. */
	add(id: string): void | Promise<void>;
	/** Record every one of `ids` as processed. Optional batch form of {@link add},
	 * the write-side twin of {@link hasMany}: a DB-backed host can write a whole
	 * batch in one round-trip. `AgxClient` uses it when present — notably for the
	 * envelopes a binding discards, whose count is set by whoever addresses junk
	 * to the agent — and falls back to per-id `add` otherwise. Idempotent. */
	addMany?(ids: string[]): void | Promise<void>;
	/** Record a FAILED processing attempt for `id` and return the running attempt
	 * count. Optional: lets a caller bound retries of a *poison* event (one whose
	 * dispatch throws deterministically) instead of leaving it unseen and holding
	 * the cursor forever. A store that omits it gets unbounded at-least-once retries
	 * (the prior behavior). The id stays UNSEEN — `add(id)` is still what marks it
	 * terminal (the caller dead-letters by calling `add` once the cap is hit).
	 * A durable multi-writer store SHOULD make this increment atomic (see the
	 * concurrency note) so the dead-letter cap can't be over-run by overlapping pumps. */
	recordFailure?(id: string): number | Promise<number>;
}

/** How long {@link InMemorySeenStore} (and stores modelled on it) keep an id.
 *
 * Replay protection has to outlive the poll window, which is a TIME span: the
 * poll overlap plus the transport's `pollLookbackSec` (for Nostr, two days of
 * NIP-59 backdate + 120 s). Three days covers that with a day of margin for a
 * briefly held cursor. A count-bounded FIFO cannot express it — how many ids
 * fit in two days depends on traffic, and on how much junk someone addresses
 * to the agent. */
export const DEFAULT_SEEN_RETENTION_SEC = 3 * 24 * 60 * 60;

/** In-memory {@link SeenStore} that keeps each id for {@link
 * DEFAULT_SEEN_RETENTION_SEC} (configurable), with a large entry cap purely as a
 * memory guard. Suitable for a single process; use a durable store across
 * restarts / multiple workers. */
export class InMemorySeenStore implements SeenStore {
	/** id -> when it was recorded (unix seconds). A Map iterates in insertion
	 * order, which is also time order, so expiry prunes from the front. */
	private readonly seenAt = new Map<string, number>();
	/** Failed-attempt counters for not-yet-seen ids (cleared once `add`-ed). */
	private readonly failures = new Map<string, number>();
	/**
	 * @param max Entry cap — a memory guard, not the retention policy. Evicting
	 *   an id still inside the poll window means re-delivering it, so keep this
	 *   well above what the retention window holds.
	 * @param retentionSec How long an id is kept; must exceed the poll overlap
	 *   plus the transport's `pollLookbackSec`.
	 */
	constructor(
		private readonly max = 200_000,
		private readonly retentionSec = DEFAULT_SEEN_RETENTION_SEC,
	) {}

	private prune(nowSec: number): void {
		const cutoff = nowSec - this.retentionSec;
		for (const [id, at] of this.seenAt) {
			if (at > cutoff && this.seenAt.size <= this.max) {
				break;
			}
			this.seenAt.delete(id);
		}
	}

	has(id: string): boolean {
		const at = this.seenAt.get(id);
		return (
			at !== undefined &&
			at > Math.floor(Date.now() / 1000) - this.retentionSec
		);
	}

	hasMany(ids: string[]): Set<string> {
		const out = new Set<string>();
		for (const id of ids) {
			if (this.has(id)) {
				out.add(id);
			}
		}
		return out;
	}

	add(id: string): void {
		this.failures.delete(id);
		const nowSec = Math.floor(Date.now() / 1000);
		if (!this.has(id)) {
			// Re-inserted so an id re-added after expiry moves to the back.
			this.seenAt.delete(id);
			this.seenAt.set(id, nowSec);
		}
		this.prune(nowSec);
	}

	addMany(ids: string[]): void {
		for (const id of ids) {
			this.add(id);
		}
	}

	recordFailure(id: string): number {
		const next = (this.failures.get(id) ?? 0) + 1;
		this.failures.set(id, next);
		// Bound the counter map too: an id that fails once and is never redelivered
		// (a relay stops serving it) is never `add`-ed, so its counter would leak.
		// Evict the oldest entry (Map preserves insertion order) once over `max`.
		if (this.failures.size > this.max) {
			const oldest = this.failures.keys().next().value;
			if (oldest !== undefined && oldest !== id) {
				this.failures.delete(oldest);
			}
		}
		return next;
	}
}
