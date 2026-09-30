import { z } from "zod";
import { AgxBodyTooLongError } from "./errors";

/**
 * The AGX payload wire format — transport-agnostic. An A2A `Message`-shaped
 * payload (roles, parts, contextId) and a `Receipt` payload, carried inside
 * whatever confidential transport a binding provides (`@nostr-agx/nostr` carries them
 * as the plaintext of a NIP-59 gift-wrapped rumor). A2A gives the *structure*; the transport gives
 * identity + integrity. The payload is labelled by a `contentType` so AGX stays
 * payload-agnostic: a peer dispatches on the content type and ignores what it
 * cannot read.
 */

/** Cap the message body in CHARACTERS.
 *
 * 27_400, down from 40_000 (and 50_000 before that), and the reason is
 * interoperability rather than taste. A transport's real limit is a BYTE limit
 * on the serialized, encrypted event, and for Nostr that ceiling is set by the
 * RECIPIENT's relay — which we do not control and which commonly runs strfry's
 * 65536-byte default. NIP-59 gift wrapping encrypts twice (rumor -> seal ->
 * wrap), each layer base64-inflating the one inside it, so the largest rumor
 * that still fits is 28_672 bytes (see {@link MAX_BODY_BYTES}). A 27_400-char
 * ASCII body with a 200-character ASCII subject makes a 28,601-byte rumor
 * (~55KB on the wire), where 40_000 would make a ~66KB wrap every
 * default-configured peer relay refuses. It is deliberately that tight: a
 * multi-byte subject can still push a body at the cap over, which the
 * transport's measured check reports with a character target.
 *
 * This is a first-order guard only, and deliberately approximate: it counts
 * characters, while the wire counts bytes of JSON-escaped UTF-8, which can be
 * several times larger. The authoritative check is the transport's `canCarry`
 * ({@link AgxTransport}), which measures the actual serialized payload. Keep
 * this at or below the byte ceiling so the common case fails here, with a clear
 * message, rather than deep in the transport. */
export const MAX_BODY = 27_400;

/** Fallback BYTE ceiling, used ONLY when a transport does not implement
 * `canCarry` — see `AgxClient.fitsWire`. `@nostr-agx/nostr` does implement it, so on
 * the Nostr path this constant is not consulted.
 *
 * 28_672 is the largest rumor (the inner NIP-44 plaintext) whose gift wrap
 * still fits a 65536-byte relay limit. `@nostr-agx/nostr` derives the same number as
 * `INTEROP_MAX_PLAINTEXT_BYTES`; it is duplicated rather than imported because
 * `@nostr-agx/core` is transport-agnostic and must not depend on a binding, and the
 * two are pinned equal by a test so the duplicate cannot drift.
 *
 * Be clear about its weakness: the fallback compares the RAW text's bytes to
 * this, while the wire carries the JSON-escaped payload plus an envelope — so
 * for heavily-escaped content it can say "fits" when the transport would not.
 * That approximation is the reason a transport that can answer precisely
 * should, and the accurate answer always wins where one exists. */
export const MAX_BODY_BYTES = 28_672;
export const MAX_SUBJECT = 200;

/** Cap on the `contentType` label in CHARACTERS.
 *
 * Named rather than inline because it is not only a validation bound: it sets
 * the largest `["content-type", …]` tag an event can carry, which `@nostr-agx/nostr`'s
 * `worstCaseEventBytes` must budget for. Written as a literal in both places,
 * the event-size upper bound silently became an under-estimate whenever this
 * moved — so the envelope is derived from this constant instead. */
export const MAX_CONTENT_TYPE = 128;

/** Cap on a body we RECEIVE, in characters — deliberately NOT {@link MAX_BODY}.
 *
 * These are different questions and sharing one constant silently conflated
 * them. `MAX_BODY` is what WE will send: a self-imposed interop bound, lowered
 * from 50_000 to 40_000 and then to 27_400 so our events fit a
 * default-configured peer relay. This
 * one is what a CONFORMING PEER may send us, and we do not get to choose it —
 * NIP-44 caps plaintext at 65_535 bytes. Whether a body that large arrives is
 * up to the relay the RECIPIENT reads from: strfry's default `maxEventSize`
 * (65536, `INTEROP_MAX_EVENT_BYTES` in `@nostr-agx/nostr`) is below
 * `MAX_CONFORMING_EVENT_BYTES`, so an operator who wants to receive full-size
 * bodies raises it above that on their own inbox relay.
 *
 * While they were the same constant, lowering the outbound cap also moved the
 * point at which `parseExchangePayload` quietly discards the tail of an INBOUND
 * body. A peer sending 45_000 characters — including a peer running the
 * previous version of this code, where 50_000 was what we advertised — had it
 * accepted by the relay, decrypted, signature-verified, stored 5_000 characters
 * short, and acknowledged with `status: delivered` and a receipt.
 *
 * `buildExchangePayload` makes the argument a few lines down: silent truncation
 * and silent partial delivery are the same bug. The receive side has the same
 * job.
 *
 * A UTF-8 character is at least one byte, so a body can never carry more
 * characters than NIP-44 can carry bytes — which makes this an upper bound no
 * conforming peer can cross, and leaves it a memory/storage guard against a
 * NON-conforming one rather than a protocol rule. Duplicated from
 * `NIP44_MAX_PLAINTEXT_BYTES` rather than imported, for the same reason
 * {@link MAX_BODY_BYTES} is: `@nostr-agx/core` must not depend on a binding. Pinned
 * equal by a test. */
export const MAX_INBOUND_BODY = 65_535;

/** The default (reference) payload content type: A2A JSON. */
export const DEFAULT_CONTENT_TYPE = "application/a2a+json";
/** Content type labelling an AGX task envelope (`AgxClient` request/result). */
export const TASK_CONTENT_TYPE = "application/agx-task+json";

/** Content types this build understands. Extend with {@link registerContentType}
 * to accept an additional payload format (payload-agnostic dispatch). */
const KNOWN_CONTENT_TYPES = new Set<string>([
	"application/a2a+json",
	"application/agx+json",
	"application/json",
	"application/agx-task+json",
]);

/** Register an additional accepted payload content type. */
export function registerContentType(contentType: string): void {
	KNOWN_CONTENT_TYPES.add(contentType);
}

/** Whether a content type is accepted by this build. */
export function isKnownContentType(contentType: string): boolean {
	return KNOWN_CONTENT_TYPES.has(contentType);
}

/** A2A-Message-shaped payload (the JSON a transport carries confidentially). */
export const exchangePayloadSchema = z.object({
	v: z.literal(1),
	kind: z.literal("message"),
	/** Content type of `parts` (payload-agnostic envelope). */
	contentType: z.string().max(MAX_CONTENT_TYPE).default(DEFAULT_CONTENT_TYPE),
	role: z.enum(["user", "agent"]).default("user"),
	/** Consecutive machine-generated replies in this message's causal chain.
	 * OPTIONAL and absent-tolerant — absent means unknown, which means zero. See
	 * "Automated-reply depth (normative)" in SPEC.md.
	 *
	 * `.catch(undefined)` is load-bearing, not defensive style. Without it, a
	 * counter that does not saturate at 255, or a peer that ships a float, fails
	 * the WHOLE payload — `parseExchangePayload` returns null and the transport
	 * drops the event as "undecryptable/malformed". An optional advisory field
	 * would then be able to make a peer silently unreachable, and its operator
	 * would see a decrypt failure for what is really a range violation. This field
	 * bounds REPLIES, never DELIVERY; an unusable value is unknown, exactly like an
	 * absent one. */
	autoDepth: z.number().int().min(0).max(255).optional().catch(undefined),
	messageId: z.string().min(1).max(200),
	contextId: z.string().min(1).max(200),
	parts: z
		.array(z.object({ text: z.string() }))
		.min(1)
		.max(64),
	// BOUNDED FOR HOSTILE INPUT, NOT BY OUR OWN CAP. This was
	// `.max(MAX_SUBJECT)` — our OUTBOUND limit — so a peer sending a 201-char
	// subject failed `safeParse`, `parseExchangePayload` returned null, and the
	// transport discarded the event as "undecryptable/malformed". The WHOLE
	// message lost over an advisory header, with nothing naming why.
	//
	// It is the argument `autoDepth` makes for itself below: an optional
	// advisory field must never be able to make a peer unreachable. That field
	// has `.catch(undefined)` for the purpose; this one had nothing. With the
	// bound relaxed, the `.slice(MAX_SUBJECT)` in parseExchangePayload becomes
	// live again (it was dead — nothing surviving the schema could exceed it)
	// and an over-long subject is shortened instead of costing the message.
	subject: z.string().max(MAX_INBOUND_BODY).nullish(),
});
export type ExchangePayload = z.infer<typeof exchangePayloadSchema>;

/** Receipt (delivery-ack) payload. */
export const receiptPayloadSchema = z.object({
	v: z.literal(1),
	kind: z.literal("receipt"),
	/** The transport id of the message being acknowledged. */
	refEventId: z.string().min(1).max(200),
	contextId: z.string().min(1).max(200),
	status: z.enum(["delivered", "quarantined"]),
});
export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;

/** The fields a parsed message exposes to the trust flow / handler. */
export interface ParsedExchangeMessage {
	text: string;
	contextId: string;
	messageId: string;
	/** How many consecutive automated replies preceded this message. `null` when
	 * the sender omitted it — treat that as 0, never as an error. Sender-declared,
	 * so it is a cooperation signal and NOT a security boundary. */
	autoDepth: number | null;
	subject: string | null;
	contentType: string;
}

/** Flatten an A2A message's text parts into one string. */
export function partsToText(parts: { text?: string }[] | undefined): string {
	return (parts ?? []).map((p) => p.text ?? "").join("");
}

/** Build a wire payload for an outbound message. */
export function buildExchangePayload(params: {
	text: string;
	contextId: string;
	messageId: string;
	subject?: string | null;
	role?: "user" | "agent";
	contentType?: string;
	/** Set to `(inbound.autoDepth ?? 0) + 1` when this message is an AUTOMATED
	 * reply. Leave it unset for anything a human authored, approved or asked for,
	 * and for a new conversation — a human in the loop resets the depth. */
	autoDepth?: number;
}): ExchangePayload {
	// THROW, DO NOT TRUNCATE. This used to `.slice(0, MAX_BODY)`, which made the
	// transport's size guard unable to ever fire: `exchangeMessagePlaintextBytes`
	// builds a payload through THIS function to measure it, and `signMessageEvent`
	// builds one to sign it, so both saw the same already-shortened text. An
	// over-long body measured small, passed the guard, and went out with its tail
	// cut off under a reported `ok: true` — `agx send` lost 20,000 characters
	// without a word. Silent truncation and silent partial delivery are the same
	// bug; neither belongs on a path whose job is to tell the caller what
	// happened.
	//
	// Every production caller now checks before building (AgxClient.fitsWire,
	// NostrTransport.publishMessage/canCarry, egress.ts), so this is the backstop
	// rather than the mechanism — it exists so the trap cannot be re-armed by the
	// next caller that forgets.
	if (params.text.length > MAX_BODY) {
		throw new AgxBodyTooLongError(params.text.length);
	}
	return {
		v: 1,
		kind: "message",
		contentType: params.contentType ?? DEFAULT_CONTENT_TYPE,
		role: params.role ?? "user",
		messageId: params.messageId,
		contextId: params.contextId,
		parts: [{ text: params.text }],
		subject: params.subject ? params.subject.slice(0, MAX_SUBJECT) : null,
		// Sanitized, not trusted. A caller bug (a float, a negative, a NaN, a
		// counter past the byte) must never become mail a peer cannot receive, so
		// it is coerced here rather than emitted and rejected at the far end.
		// OMITTED at zero rather than written as `0`, so the common case stays
		// byte-identical to what every pre-autoDepth peer already emits and every
		// pre-autoDepth parser already expects.
		...sanitizedDepth(params.autoDepth),
	};
}

/** `{ autoDepth: n }` for a usable positive depth, `{}` for anything else. */
function sanitizedDepth(value: number | undefined): { autoDepth?: number } {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return {};
	}
	const depth = Math.min(255, Math.max(0, Math.trunc(value)));
	return depth > 0 ? { autoDepth: depth } : {};
}

/** Parse + validate a decrypted MESSAGE payload. Returns null on any malformed/
 * oversize payload (attacker-controlled) or an unknown content type. */
export function parseExchangePayload(
	raw: unknown,
): ParsedExchangeMessage | null {
	const parsed = exchangePayloadSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	if (!KNOWN_CONTENT_TYPES.has(parsed.data.contentType)) {
		return null;
	}
	// MAX_INBOUND_BODY, not MAX_BODY: what a peer may send is not what we send.
	// See the constant. No conforming peer can exceed this, so in practice this
	// slice is now unreachable and exists to bound a hostile one.
	const text = partsToText(parsed.data.parts).slice(0, MAX_INBOUND_BODY);
	if (!text) {
		return null;
	}
	return {
		text,
		contextId: parsed.data.contextId,
		messageId: parsed.data.messageId,
		// Returned, unlike `role` — which is declared on the schema, hardcoded by
		// the Nostr binding, and dropped right here, which is why it has never
		// carried anything. A field the parser discards cannot bound a loop.
		autoDepth: parsed.data.autoDepth ?? null,
		subject: parsed.data.subject
			? parsed.data.subject.slice(0, MAX_SUBJECT)
			: null,
		contentType: parsed.data.contentType,
	};
}

/** Build a Receipt (delivery-ack) payload. */
export function buildReceiptPayload(params: {
	refEventId: string;
	contextId: string;
	status: "delivered" | "quarantined";
}): ReceiptPayload {
	return {
		v: 1,
		kind: "receipt",
		refEventId: params.refEventId,
		contextId: params.contextId,
		status: params.status,
	};
}

/** Parse + validate a decrypted RECEIPT payload. Returns null when malformed. */
export function parseReceiptPayload(raw: unknown): ReceiptPayload | null {
	const parsed = receiptPayloadSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}
