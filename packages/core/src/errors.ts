/**
 * A task-handler error whose message is SAFE to send across the trust boundary to
 * the requesting peer. By default a thrown handler error is reported to the peer
 * as a generic "handler failed" (and the real message logged locally), so an
 * internal error — a driver/ORM/HTTP failure carrying hostnames, table names, or
 * connection strings — never leaks to another org. Throw `AgxPublicError` when you
 * intend the message to be part of the protocol contract (e.g. "invoice not
 * found", "amount exceeds limit").
 *
 *   agx.handle("invoice.review", (t) => {
 *     if (!found) throw new AgxPublicError("invoice not found");
 *     ...
 *   });
 */
export class AgxPublicError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgxPublicError";
	}
}

/**
 * A message body over {@link MAX_BODY} characters, thrown by
 * `buildExchangePayload` rather than silently shortening it.
 *
 * This is a BACKSTOP, not the intended failure path. Every caller that can
 * produce a user-facing result checks the length first and reports it cleanly —
 * `AgxClient.fitsWire`, `NostrTransport.publishMessage`, `egress.ts`. Reaching
 * this throw means one of them was bypassed, which is exactly when a loud
 * failure beats a body delivered with its tail missing.
 */
export class AgxBodyTooLongError extends Error {
	constructor(public readonly chars: number) {
		super(
			`AGX message body is too long (${chars} characters). Callers must check the limit and report it; reaching this means the body would otherwise have been truncated silently.`,
		);
		this.name = "AgxBodyTooLongError";
	}
}
