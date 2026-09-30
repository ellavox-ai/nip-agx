import {
	buildExchangePayload,
	buildReceiptPayload,
	type ExchangePayload,
	MAX_CONTENT_TYPE,
	type ParsedExchangeMessage,
	parseExchangePayload,
	parseReceiptPayload,
	type ReceiptPayload,
} from "@nostr-agx/core";
import type { Event } from "nostr-tools";
import {
	createRumor,
	type UnwrappedRumor,
	unwrapRumor,
	wrapRumor,
} from "./giftwrap";
import { randomId } from "./ids";
import { CARD_KIND, DELETION_KIND, MESSAGE_KIND, RECEIPT_KIND } from "./kinds";
import type { AgxSigner } from "./signer";

/**
 * Map AGX payloads to/from gift-wrapped Nostr events (see `./giftwrap`). The
 * payload JSON is the plaintext `content` of an unsigned rumor (kind 3838 /
 * 3839) that `p`-tags the recipient and, for messages, carries a
 * `content-type` tag; the rumor is then sealed and wrapped, so both layers of
 * NIP-44 sit between it and the relay.
 */

/** OUR cap on any single NIP-44 plaintext, 65535 bytes.
 *
 * Deliberately not described as "NIP-44's limit" any more: the current spec's
 * `max_plaintext_size` is 2^32 - 1, and it widens the length prefix from 2 to 6
 * bytes at 65536 (`extended_prefix_threshold`). 65535 is where this build draws
 * the line — it keeps every event we sign inside the relay's maxEventSize with
 * the 2-byte prefix, and it is what a relay's `maxEventSize` should be sized against.
 *
 * It binds TWICE per event: on the rumor (the inner plaintext) and on the seal
 * (the outer one), and the seal is the larger — a base64 rendering of the
 * encrypted rumor plus its own JSON. The caller's text sits JSON-escaped inside
 * the payload, which sits JSON-escaped inside the rumor, so every quote,
 * newline or control character inflates 4x or more. This is a property of the
 * SERIALIZED layers, not of the raw body.
 *
 * Note this is the looser of the ceilings. What bounds an outbound message in
 * practice is {@link INTEROP_MAX_EVENT_BYTES}, because the recipient's relay is
 * usually stricter than NIP-44. */
export const NIP44_MAX_PLAINTEXT_BYTES = 65535;

/** Thrown when a serialized message/receipt would exceed
 * {@link NIP44_MAX_PLAINTEXT_BYTES} at either encryption layer. Callers (the
 * transport) catch it and fail cleanly (`ok:false`) rather than letting
 * `nip44.encrypt` throw. */
export class AgxPayloadTooLargeError extends Error {
	readonly bytes: number;
	constructor(bytes: number) {
		super(
			`AGX payload exceeds the NIP-44 plaintext limit (${bytes} bytes serialized; limit ${NIP44_MAX_PLAINTEXT_BYTES})`,
		);
		this.name = "AgxPayloadTooLargeError";
		this.bytes = bytes;
	}
}

/** A maximal hex id / pubkey, for sizing skeletons. */
const HEX64_MAX = "0".repeat(64);
/** A maximal unix timestamp, for sizing skeletons. */
const CREATED_AT_MAX = 9_999_999_999;

/** Byte size of the INNER plaintext a message with `text` produces — i.e. the
 * JSON of the rumor the transport actually seals, with the exchange payload
 * JSON-escaped inside its `content`, so both rounds of escaping are counted.
 * Conservative on the envelope (max-length id/subject placeholders, maximal
 * content-type tag) so a "fits" answer here can never become an oversize throw
 * at sign time. Byte cap only — the char cap (`MAX_BODY`) is the core's
 * concern. Uses `TextEncoder` (not `Buffer`) so it works in edge/browser
 * builds too. */
export function exchangeMessagePlaintextBytes(
	text: string,
	opts?: { contentType?: string; subject?: string | null },
): number {
	// 200 = the wire schema's max for messageId/contextId; a 200-char subject is
	// its cap too. Real ids are shorter (UUIDs), so this over-counts slightly.
	const maxId = "x".repeat(200);
	const payload = buildExchangePayload({
		text,
		contentType: opts?.contentType,
		subject: opts?.subject ?? maxId,
		messageId: maxId,
		contextId: maxId,
	});
	return rumorBytes(JSON.stringify(payload), [
		["p", HEX64_MAX],
		["content-type", "x".repeat(MAX_CONTENT_TYPE)],
	]);
}

/** Serialized size of a rumor carrying `content` and `tags`, with maximal
 * id/pubkey/timestamp. */
function rumorBytes(content: string, tags: string[][]): number {
	return new TextEncoder().encode(
		JSON.stringify({
			id: HEX64_MAX,
			pubkey: HEX64_MAX,
			created_at: CREATED_AT_MAX,
			kind: 30000,
			tags,
			content,
		}),
	).length;
}

/**
 * The event-size ceiling we must fit to be deliverable to an ARBITRARY peer.
 *
 * 65536 is strfry's DEFAULT `events.maxEventSize`. The sender's own relay may
 * raise it, but that is irrelevant to this number: `NostrTransport.publishMessage`
 * routes to the recipient's NIP-65 relays as well as the sender's, so the binding
 * constraint is
 * whatever the PEER runs — and a peer on defaults is the common case, not the
 * pathological one.
 */
export const INTEROP_MAX_EVENT_BYTES = 65536;

/** NIP-44 v2's length prefix widens above this size: below it a 2-byte u16,
 * at or above it 6 bytes (two zero bytes + a u32). Spec constant
 * `extended_prefix_threshold`. */
const NIP44_EXTENDED_PREFIX_THRESHOLD = 65536;

/**
 * NIP-44 v2 `calc_padded_len`, transcribed from the spec.
 *
 * Padding rounds up to a multiple of `next_power / 8` — NOT to `next_power`.
 * That distinction is the whole reason this function exists as code rather than
 * a one-liner: a next-power-of-two model is ~2x pessimistic just above a power
 * of two, and this file previously carried one and described its output as a
 * "step function" with nothing in between. It is not. Overhead above a power of
 * two is capped at 12.5%.
 *
 * Pinned against the spec's own test vector in events.test.ts
 * (`calc_padded_len(74123) === 81920`, where the power-of-two model says
 * 131072). That assertion is what would have caught the original error.
 */
export function nip44PaddedLen(plaintextBytes: number): number {
	if (plaintextBytes <= 32) {
		return 32;
	}
	const nextPower = 1 << (Math.floor(Math.log2(plaintextBytes - 1)) + 1);
	const chunk = nextPower <= 256 ? 32 : nextPower / 8;
	return chunk * (Math.floor((plaintextBytes - 1) / chunk) + 1);
}

/** Exact length of the base64 NIP-44 payload for `plaintextBytes`.
 *
 * Wire form is version(1) + nonce(32) + ciphertext + mac(32), base64-encoded.
 * ChaCha20 is a stream cipher, so the ciphertext is exactly the padded
 * plaintext: the length prefix plus {@link nip44PaddedLen}. */
function nip44PayloadBytes(plaintextBytes: number): number {
	const prefix = plaintextBytes >= NIP44_EXTENDED_PREFIX_THRESHOLD ? 6 : 2;
	const binary = 1 + 32 + (prefix + nip44PaddedLen(plaintextBytes)) + 32;
	return 4 * Math.ceil(binary / 3);
}

/**
 * Every byte of a normalized SEAL (kind 13) except its `content`: no tags, and
 * maximal id/pubkey/sig/timestamp.
 *
 * MEASURED, NOT COUNTED BY HAND, like {@link WRAP_ENVELOPE_BYTES}. A hand
 * count was wrong twice in this file's history, and an under-estimate is the
 * wrong direction for a function whose entire job is an upper bound.
 */
const SEAL_ENVELOPE_BYTES = new TextEncoder().encode(
	JSON.stringify({
		id: HEX64_MAX,
		pubkey: HEX64_MAX,
		created_at: CREATED_AT_MAX,
		kind: 30000,
		tags: [],
		content: "",
		sig: "0".repeat(128),
	}),
).length;

/**
 * Every byte of a normalized gift WRAP (kind 1059) except its `content`: the
 * three tags it always carries — `p`, a maximal NIP-40 `expiration`, and a
 * NIP-13 `nonce` sized for the largest iteration count the miner can reach —
 * plus maximal id/pubkey/sig/timestamp.
 */
const WRAP_ENVELOPE_BYTES = new TextEncoder().encode(
	JSON.stringify({
		id: HEX64_MAX,
		pubkey: HEX64_MAX,
		created_at: CREATED_AT_MAX,
		kind: 30000,
		tags: [
			["p", HEX64_MAX],
			["expiration", String(CREATED_AT_MAX)],
			["nonce", String(CREATED_AT_MAX), "256"],
		],
		content: "",
		sig: "0".repeat(128),
	}),
).length;

/** Plaintext size of the SEAL — the outer NIP-44 layer's input — for a rumor
 * of `rumorBytes`. */
function sealPlaintextBytes(rumorBytes: number): number {
	return SEAL_ENVELOPE_BYTES + nip44PayloadBytes(rumorBytes);
}

/**
 * Upper bound on the normalized gift-wrap size produced by a rumor of
 * `plaintextBytes` (see {@link exchangeMessagePlaintextBytes}): the rumor is
 * NIP-44-encrypted into a seal, and the seal NIP-44-encrypted into the wrap.
 */
export function worstCaseEventBytes(plaintextBytes: number): number {
	return (
		WRAP_ENVELOPE_BYTES +
		nip44PayloadBytes(sealPlaintextBytes(plaintextBytes))
	);
}

/**
 * The largest gift wrap a CONFORMING peer can send: one whose seal plaintext
 * is exactly {@link NIP44_MAX_PLAINTEXT_BYTES}. (A rumor that large cannot be
 * sent at all — its seal would be bigger still — so
 * `worstCaseEventBytes(NIP44_MAX_PLAINTEXT_BYTES)` over-states it.) This is
 * what a relay must accept to receive every protocol-valid AGX event, and what
 * a relay's `maxEventSize` should be sized against.
 */
export const MAX_CONFORMING_EVENT_BYTES =
	WRAP_ENVELOPE_BYTES + nip44PayloadBytes(NIP44_MAX_PLAINTEXT_BYTES);

/**
 * The largest rumor whose worst-case wrap still fits
 * {@link INTEROP_MAX_EVENT_BYTES}. Derived rather than written down, so the two
 * cannot drift apart.
 *
 * Searched rather than doubled. Padding makes the answer a multiple of a chunk
 * size, not a power of two, so a doubling loop cannot express it in general;
 * walk chunk-aligned candidates upward and keep the last that fits.
 */
export const INTEROP_MAX_PLAINTEXT_BYTES = (() => {
	let best = 1;
	// worstCaseEventBytes is monotonic, so the first size that does not fit ends
	// it. Step by the smallest chunk (32) — the search space is bounded by the
	// interop ceiling and this runs once at module load.
	for (
		let bytes = 32;
		bytes <= NIP44_EXTENDED_PREFIX_THRESHOLD;
		bytes += 32
	) {
		if (worstCaseEventBytes(bytes) > INTEROP_MAX_EVENT_BYTES) {
			break;
		}
		best = bytes;
	}
	return best;
})();

/** Guard both NIP-44 layers of a rumor before anything is encrypted, so an
 * oversize payload surfaces as a typed error instead of `nip44.encrypt`'s
 * throw. */
function assertEncryptable(rumorJson: string): void {
	const bytes = new TextEncoder().encode(rumorJson).length;
	if (bytes > NIP44_MAX_PLAINTEXT_BYTES) {
		throw new AgxPayloadTooLargeError(bytes);
	}
	const sealBytes = sealPlaintextBytes(bytes);
	if (sealBytes > NIP44_MAX_PLAINTEXT_BYTES) {
		throw new AgxPayloadTooLargeError(sealBytes);
	}
}

/** A signed, wrapped AGX event ready to publish. */
export interface WrappedAgxEvent {
	/** The kind-1059 gift wrap — what goes to relays. */
	event: Event;
	/** The rumor's id: the durable identity of this message/receipt. A receipt's
	 * `refEventId` names it, and a recipient dedupes on it, so a re-wrapped
	 * retry of the same rumor is still recognized. */
	rumorId: string;
}

/** Build a message rumor to `recipientPubkey`, then seal + gift-wrap it. */
export async function signMessageEvent(params: {
	signer: AgxSigner;
	recipientPubkey: string;
	text: string;
	subject?: string | null;
	contextId?: string | null;
	nowSec: number;
	contentType?: string;
	/** Automated-reply depth to declare. Passed through rather than hardcoded —
	 * unlike `role` below, which AGX does not interpret. See "Automated-reply
	 * depth (normative)" in `@nostr-agx/core`'s SPEC.md. */
	autoDepth?: number;
	/** NIP-13 difficulty to mine the wrap to (default {@link AGX_POW_BITS}). */
	powBits?: number;
}): Promise<WrappedAgxEvent & { payload: ExchangePayload }> {
	const payload = buildExchangePayload({
		text: params.text,
		subject: params.subject ?? null,
		contextId: params.contextId || randomId(),
		messageId: randomId(),
		// A2A's turn label, which AGX does not interpret and implementations must
		// not derive automation or trust from — so it stays pinned.
		role: "user",
		autoDepth: params.autoDepth,
		contentType: params.contentType,
	});
	const rumor = createRumor({
		pubkey: await params.signer.getPublicKey(),
		kind: MESSAGE_KIND,
		tags: [
			["p", params.recipientPubkey],
			["content-type", payload.contentType],
		],
		content: JSON.stringify(payload),
		nowSec: params.nowSec,
	});
	// Guard the ACTUAL serialized layers (not the raw text): a typed throw here
	// lets the transport return `ok:false` instead of surfacing
	// `nip44.encrypt`'s throw as a 500 / a misleading "publish failed".
	assertEncryptable(JSON.stringify(rumor));
	const event = await wrapRumor({
		signer: params.signer,
		rumor,
		recipientPubkey: params.recipientPubkey,
		nowSec: params.nowSec,
		powBits: params.powBits,
	});
	return { event, rumorId: rumor.id, payload };
}

/** Build a Receipt (delivery-ack) rumor back to a message's sender, then seal
 * + gift-wrap it. */
export async function signReceiptEvent(params: {
	signer: AgxSigner;
	recipientPubkey: string;
	/** The acknowledged message's RUMOR id. */
	refEventId: string;
	contextId: string;
	status: "delivered" | "quarantined";
	nowSec: number;
	powBits?: number;
}): Promise<WrappedAgxEvent> {
	const payload = buildReceiptPayload({
		refEventId: params.refEventId,
		contextId: params.contextId,
		status: params.status,
	});
	const rumor = createRumor({
		pubkey: await params.signer.getPublicKey(),
		kind: RECEIPT_KIND,
		tags: [
			["p", params.recipientPubkey],
			["e", params.refEventId],
		],
		content: JSON.stringify(payload),
		nowSec: params.nowSec,
	});
	// Receipts carry only fixed, bounded fields, so this is unreachable in
	// practice — but guard it so no path can 500 on encrypt.
	assertEncryptable(JSON.stringify(rumor));
	const event = await wrapRumor({
		signer: params.signer,
		rumor,
		recipientPubkey: params.recipientPubkey,
		nowSec: params.nowSec,
		powBits: params.powBits,
	});
	return { event, rumorId: rumor.id };
}

/**
 * Build + sign a NIP-09 deletion request (kind 5) for events this key authored.
 *
 * Used to RETRACT a published Agent Card / relay list when an agent de-lists.
 * UNENCRYPTED by necessity — a relay has to read the `e` tags to act on it, and
 * it reveals nothing the (already public) card didn't. Relays are NOT obliged to
 * honor deletions, so callers must treat retraction as best-effort and must not
 * report it to a user as a guarantee.
 */
export function signDeletionEvent(params: {
	signer: AgxSigner;
	/** Ids of the caller's own events to retract. A relay ignores `e` tags naming
	 * events this key did not author, so this cannot delete another agent's card. */
	eventIds: string[];
	/** Optional human-readable reason, carried in `content` per NIP-09. */
	reason?: string | null;
	nowSec: number;
}): Promise<Event> {
	return params.signer.signEvent({
		kind: DELETION_KIND,
		created_at: params.nowSec,
		tags: [
			...params.eventIds.map((id) => ["e", id]),
			// Naming the kind lets a relay apply the deletion to replaceable
			// events (the Agent Card is kind 11337) as well as by-id.
			["k", String(CARD_KIND)],
		],
		content: params.reason ?? "",
	});
}

/** Identity + timing shared by an opened message and an opened receipt. */
interface OpenedRumorMeta {
	/** The sender, as proven by the seal's signature. */
	senderPubkey: string;
	/** The RUMOR id — the event's durable identity (receipt ref, dedupe key). */
	eventId: string;
	/** The outer wrap's `created_at`. Deliberately randomized up to
	 * `MAX_WRAP_BACKDATE_SEC` into the past, so it says nothing about when the
	 * event was sent; it is the timestamp an inbox cursor is measured against. */
	createdAt: number;
	/** The rumor's `created_at` — when the sender says it was sent. Sender-
	 * declared and unverifiable, like any Nostr timestamp. */
	sentAt: number;
}

export interface OpenedMessage extends ParsedExchangeMessage, OpenedRumorMeta {}

export interface OpenedReceipt extends OpenedRumorMeta {
	receipt: ReceiptPayload;
}

function rumorMeta(unwrapped: UnwrappedRumor): OpenedRumorMeta {
	return {
		senderPubkey: unwrapped.from,
		eventId: unwrapped.rumor.id,
		createdAt: unwrapped.wrapCreatedAt,
		sentAt: unwrapped.rumor.created_at,
	};
}

function parseRumorJson(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/** Parse an already-unwrapped rumor as a message. Null on another kind or a
 * malformed/oversize payload. */
export function openMessageRumor(
	unwrapped: UnwrappedRumor,
): OpenedMessage | null {
	if (unwrapped.rumor.kind !== MESSAGE_KIND) {
		return null;
	}
	const parsed = parseExchangePayload(
		parseRumorJson(unwrapped.rumor.content),
	);
	return parsed ? { ...rumorMeta(unwrapped), ...parsed } : null;
}

/** Parse an already-unwrapped rumor as a receipt. Null on another kind or a
 * malformed payload. */
export function openReceiptRumor(
	unwrapped: UnwrappedRumor,
): OpenedReceipt | null {
	if (unwrapped.rumor.kind !== RECEIPT_KIND) {
		return null;
	}
	const receipt = parseReceiptPayload(
		parseRumorJson(unwrapped.rumor.content),
	);
	return receipt ? { ...rumorMeta(unwrapped), receipt } : null;
}

/** Unwrap + parse an inbound gift-wrapped message. The wrap's signature is
 * assumed already verified (the relay pool verifies on ingest). Rejects only
 * with the signer's `AgxSignerUnavailableError`, as {@link unwrapRumor} does. */
export async function openMessageEvent(params: {
	signer: AgxSigner;
	event: Event;
}): Promise<OpenedMessage | null> {
	const unwrapped = await unwrapRumor(params);
	return unwrapped ? openMessageRumor(unwrapped) : null;
}

/** Unwrap + parse an inbound gift-wrapped RECEIPT from a peer. Rejects only
 * with the signer's `AgxSignerUnavailableError`, as {@link unwrapRumor} does. */
export async function openReceiptEvent(params: {
	signer: AgxSigner;
	event: Event;
}): Promise<OpenedReceipt | null> {
	const unwrapped = await unwrapRumor(params);
	return unwrapped ? openReceiptRumor(unwrapped) : null;
}
