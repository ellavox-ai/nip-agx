import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
	type Event,
	finalizeEvent,
	generateSecretKey,
	getEventHash,
	getPublicKey,
	nip44,
	type UnsignedEvent,
	verifyEvent,
} from "nostr-tools";
import { GIFT_WRAP_KIND, SEAL_KIND } from "./kinds";
import { type AgxSigner, isSignerUnavailable } from "./signer";

/**
 * NIP-59 gift wrap: the transport envelope for every AGX message and receipt.
 *
 *   rumor (kind 3838/3839, UNSIGNED) — the AGX payload in plaintext `content`,
 *     `pubkey` = the real sender. Unsigned so a leaked rumor proves nothing.
 *   seal  (kind 13) — the rumor NIP-44-encrypted to the recipient, signed by the
 *     sender. No tags, backdated `created_at`.
 *   wrap  (kind 1059) — the seal NIP-44-encrypted to the recipient, signed by a
 *     ONE-TIME key. Carries the only public metadata: `p` (the recipient),
 *     NIP-40 `expiration`, and a NIP-13 `nonce`. Backdated `created_at`.
 *
 * So a relay (or anyone reading it) sees who a wrap is FOR, but not who sent it,
 * when it was really sent, or what kind of AGX event it is. The sender's
 * identity is only provable to the recipient, via the seal's signature.
 */

/** How far into the past a seal / wrap `created_at` may be randomized
 * (NIP-59's "up to two days"). NORMATIVE for receivers: an inbox poll must look
 * back at least this far behind its cursor, or a wrap stamped earlier than the
 * cursor is never fetched. */
export const MAX_WRAP_BACKDATE_SEC = 2 * 24 * 60 * 60;

/** NIP-40 lifetime of EVERY gift wrap, counted from its (backdated)
 * `created_at`. One value for messages and receipts alike, deliberately:
 * `expiration − created_at` is visible to anyone reading the relay, so it must
 * be the same constant for every wrap. A per-kind TTL, or one counted from the
 * real clock, would publish the kind and the true send time that the backdate
 * exists to hide. A wrap backdated the full two days still lives 28 real days —
 * far above any ingest outage the held-cursor alarm tolerates — and every wrap
 * stays under {@link MAX_EXPIRATION_SEC}. */
export const WRAP_TTL_SEC = 30 * 24 * 60 * 60;
/** The furthest ahead an `expiration` may sit. A relay enforcing NIP-AGX 0.2.0
 * may reject wraps beyond it in its write policy, so storage stays bounded even
 * against a client that asks for "forever". */
export const MAX_EXPIRATION_SEC = 31 * 24 * 60 * 60;

/** NIP-13 difficulty every wrap is mined to, and the minimum a relay enforcing
 * NIP-AGX 0.2.0 may require in its write policy. About 4k hashes — milliseconds per event, so an
 * ingest tick acknowledging a batch stays fast, while a flood costs real CPU.
 * Mined on the wrap only: it is signed by a throwaway key, so it is the one
 * event a pubkey allow-list cannot vouch for. */
export const AGX_POW_BITS = 12;

/** Bound on mining iterations. At {@link AGX_POW_BITS} the expected count is
 * 2^12; hitting this means the difficulty was misconfigured, and throwing beats
 * pinning a CPU forever. */
const MAX_POW_ITERATIONS = 1 << 24;

/** An AGX event before wrapping: what the recipient ends up holding. */
export interface Rumor {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
}

function randomBackdate(nowSec: number): number {
	// A CSPRNG, not Math.random: this offset IS the timing-privacy mechanism,
	// and every wrap publishes `nowSec - offset` on a public relay. V8's
	// Math.random (xorshift128+) state is recoverable from a handful of
	// outputs, which would let an observer predict every later offset and undo
	// the backdate for this process. `crypto` is global in Node >= 19, browsers
	// and edge runtimes.
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return nowSec - Math.floor((buf[0] / 2 ** 32) * MAX_WRAP_BACKDATE_SEC);
}

/** Build an unsigned rumor; its `id` is the event hash, which is what AGX uses
 * as the message's identity (receipt `refEventId`, inbound dedupe). */
export function createRumor(params: {
	pubkey: string;
	kind: number;
	tags: string[][];
	content: string;
	nowSec: number;
}): Rumor {
	const unsigned: UnsignedEvent = {
		pubkey: params.pubkey,
		kind: params.kind,
		tags: params.tags,
		content: params.content,
		created_at: params.nowSec,
	};
	return { ...unsigned, id: getEventHash(unsigned) };
}

/** Test seam for {@link mineWrap}, which is otherwise only reachable through
 * {@link wrapRumor} with inputs that cannot trip its guards. */
export function __mineWrapForTests(
	template: Omit<UnsignedEvent, "pubkey">,
	pubkey: string,
	difficulty: number,
): UnsignedEvent {
	return mineWrap(template, pubkey, difficulty);
}

/** Stand-in for the nonce while serializing. Cannot occur elsewhere in a wrap:
 * `content` is base64 (no underscores) and the other tags are hex / digits. */
const NONCE_PLACEHOLDER = "__AGX_NONCE__";

/** Leading zero bits of a hash (NIP-13 difficulty). */
function leadingZeroBits(hash: Uint8Array): number {
	let bits = 0;
	for (const byte of hash) {
		if (byte === 0) {
			bits += 8;
			continue;
		}
		return bits + Math.clz32(byte) - 24;
	}
	return bits;
}

/**
 * Mine `template` to `difficulty` leading zero bits by varying a NIP-13 nonce,
 * WITHOUT touching `created_at`. (nostr-tools' `minePow` re-stamps
 * `created_at` with the current time, which would undo the NIP-59 backdate.)
 * The nonce tag commits to the target, per NIP-13.
 *
 * The event id is sha256 over the NIP-01 serialization, and everything before
 * the nonce's digits is fixed, so that prefix is hashed ONCE and each attempt
 * only hashes the digits and what follows. The `content` still has to be
 * re-hashed every time (it serializes after the tags), which is why a large
 * message costs more to mine than a receipt.
 */
function mineWrap(
	template: Omit<UnsignedEvent, "pubkey">,
	pubkey: string,
	difficulty: number,
): UnsignedEvent {
	const nonceTag = ["nonce", "0", String(difficulty)];
	const unsigned: UnsignedEvent = {
		...template,
		pubkey,
		tags: [...template.tags, nonceTag],
	};
	if (difficulty <= 0) {
		return unsigned;
	}
	nonceTag[1] = NONCE_PLACEHOLDER;
	const serialized = JSON.stringify([
		0,
		unsigned.pubkey,
		unsigned.created_at,
		unsigned.kind,
		unsigned.tags,
		unsigned.content,
	]);
	const at = serialized.indexOf(NONCE_PLACEHOLDER);
	if (at < 0) {
		throw new Error("NIP-13: nonce placeholder not found in serialization");
	}
	const encoder = new TextEncoder();
	const prefix = sha256
		.create()
		.update(encoder.encode(serialized.slice(0, at)));
	const suffix = encoder.encode(
		serialized.slice(at + NONCE_PLACEHOLDER.length),
	);
	for (let n = 1; n <= MAX_POW_ITERATIONS; n++) {
		const hash = prefix
			.clone()
			.update(encoder.encode(String(n)))
			.update(suffix)
			.digest();
		if (leadingZeroBits(hash) >= difficulty) {
			nonceTag[1] = String(n);
			// The prefix/suffix split is only valid if the placeholder we split on
			// was the nonce's own — an earlier tag carrying the same text would
			// have us mine bytes the event does not serialize to, and every relay
			// would then answer "pow: difficulty N is less than …" far from the
			// cause. One real hash of the final event makes that impossible.
			if (
				leadingZeroBits(hexToBytes(getEventHash(unsigned))) < difficulty
			) {
				throw new Error(
					"NIP-13: mined nonce does not hold on the serialized event",
				);
			}
			return unsigned;
		}
	}
	throw new Error(`NIP-13: no nonce reached ${difficulty} bits`);
}

/**
 * Seal `rumor` for `recipientPubkey` and gift-wrap it.
 *
 * `rumor.pubkey` must be the signer's own key: the recipient rejects a seal
 * whose signer differs from the rumor's claimed author.
 */
export async function wrapRumor(params: {
	signer: AgxSigner;
	rumor: Rumor;
	recipientPubkey: string;
	nowSec: number;
	powBits?: number;
}): Promise<Event> {
	const seal = await params.signer.signEvent({
		kind: SEAL_KIND,
		created_at: randomBackdate(params.nowSec),
		tags: [],
		content: await params.signer.nip44Encrypt(
			params.recipientPubkey,
			JSON.stringify(params.rumor),
		),
	});

	const ephemeral = generateSecretKey();
	const content = nip44.encrypt(
		JSON.stringify(seal),
		nip44.getConversationKey(ephemeral, params.recipientPubkey),
	);
	const wrapCreatedAt = randomBackdate(params.nowSec);
	const mined = mineWrap(
		{
			kind: GIFT_WRAP_KIND,
			created_at: wrapCreatedAt,
			tags: [
				["p", params.recipientPubkey],
				// From the BACKDATED created_at, with one TTL for every wrap, so
				// `expiration − created_at` is a constant that says nothing. From
				// the real clock (or per kind), this tag would republish exactly
				// what the backdate hides: `expiration − ttl` is the true send
				// time, and which TTL fits reveals the kind.
				["expiration", String(wrapCreatedAt + WRAP_TTL_SEC)],
			],
			content,
		},
		getPublicKey(ephemeral),
		params.powBits ?? AGX_POW_BITS,
	);
	return finalizeEvent(
		{
			kind: mined.kind,
			created_at: mined.created_at,
			tags: mined.tags,
			content: mined.content,
		},
		ephemeral,
	);
}

export interface UnwrappedRumor {
	/** The sender, as proven by the seal's signature. */
	from: string;
	rumor: Rumor;
	/** The outer wrap's id — the transport-level identity of this delivery. */
	wrapId: string;
	/** The outer wrap's (backdated) `created_at`: what an inbox cursor is
	 * measured against. */
	wrapCreatedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isRumor(value: unknown): value is Rumor {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const r = value as Record<string, unknown>;
	return (
		typeof r.id === "string" &&
		typeof r.pubkey === "string" &&
		HEX64.test(r.pubkey) &&
		typeof r.created_at === "number" &&
		typeof r.kind === "number" &&
		typeof r.content === "string" &&
		Array.isArray(r.tags) &&
		r.tags.every(
			(t) => Array.isArray(t) && t.every((v) => typeof v === "string"),
		)
	);
}

/**
 * Open a gift wrap addressed to the signer. Null on anything that does not
 * check out, so one bad event cannot fail a poll. The one thing it throws is
 * an {@link AgxSignerUnavailableError} from the signer: that says nothing about
 * the wrap, and turning it into null would get a good wrap discarded for good.
 *
 * The wrap's own signature is assumed already verified (the relay pool does it
 * on ingest). Beyond decrypting, this enforces what makes the result
 * trustworthy:
 *  - the seal is a validly signed kind 13;
 *  - the rumor's claimed author IS the seal's signer — otherwise anyone could
 *    seal a rumor "from" someone else (the impersonation check NIP-59 requires);
 *  - the rumor's id is the hash of its contents, so it can be used as an
 *    identity;
 *  - the rumor names us in a `p` tag, so a wrap re-addressed to us cannot
 *    smuggle in a rumor meant for somebody else.
 */
export async function unwrapRumor(params: {
	signer: AgxSigner;
	event: Event;
}): Promise<UnwrappedRumor | null> {
	const { event, signer } = params;
	if (event.kind !== GIFT_WRAP_KIND) {
		return null;
	}
	try {
		const me = await signer.getPublicKey();
		const seal = JSON.parse(
			await signer.nip44Decrypt(event.pubkey, event.content),
		) as Event;
		if (seal?.kind !== SEAL_KIND || !verifyEvent(seal)) {
			return null;
		}
		const rumor: unknown = JSON.parse(
			await signer.nip44Decrypt(seal.pubkey, seal.content),
		);
		if (!isRumor(rumor)) {
			return null;
		}
		if (rumor.pubkey !== seal.pubkey) {
			return null;
		}
		const { id, ...unsigned } = rumor;
		if (getEventHash(unsigned) !== id) {
			return null;
		}
		if (!rumor.tags.some((t) => t[0] === "p" && t[1] === me)) {
			return null;
		}
		return {
			from: seal.pubkey,
			rumor: {
				id,
				pubkey: rumor.pubkey,
				created_at: rumor.created_at,
				kind: rumor.kind,
				tags: rumor.tags,
				content: rumor.content,
			},
			wrapId: event.id,
			wrapCreatedAt: event.created_at,
		};
	} catch (err) {
		if (isSignerUnavailable(err)) {
			throw err;
		}
		return null;
	}
}

/** The NIP-40 `expiration` of an event, or null when it carries none. */
export function eventExpiration(event: Event): number | null {
	const tag = event.tags.find((t) => t[0] === "expiration");
	if (!tag?.[1]) {
		return null;
	}
	const value = Number(tag[1]);
	return Number.isFinite(value) ? value : null;
}
