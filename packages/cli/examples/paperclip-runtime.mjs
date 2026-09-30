/**
 * A third-party agent runtime, plugged into the exchange.
 *
 *   agx serve --handler ./examples/paperclip-runtime.mjs
 *
 * This is the ENTIRE integration surface. The module exports capability keys and
 * their implementations; `@nostr-agx/core` + `@nostr-agx/nostr` own identity, NIP-44
 * encryption, relay routing, the task lifecycle, correlation, receipts and
 * replay protection. The runtime never sees a Nostr event.
 *
 * Swap the bodies for calls into Paperclip (or any HTTP service, LLM, or rules
 * engine) and nothing else changes — the protocol does not care what a
 * capability is implemented with.
 */

/** Stand-in for the real service. Replace with your own client. */
async function runPaperclip(skill, input) {
	// e.g. await fetch("https://paperclip.internal/run", { method: "POST", ... })
	if (skill === "invoice.review") {
		const amount = Number(input.amount ?? 0);
		const flags = [];
		if (amount > 10_000) {
			flags.push("above-approval-threshold");
		}
		if (!input.purchaseOrder) {
			flags.push("missing-purchase-order");
		}
		return {
			approved: flags.length === 0,
			flags,
			confidence: 0.93,
			rationale: flags.length
				? `Held for review: ${flags.join(", ")}.`
				: `Vendor ${input.vendor ?? "unknown"} and amount ${amount} are within policy.`,
		};
	}
	throw new Error(`unknown skill ${skill}`);
}

export default {
	"invoice.review": async (payload) => {
		const result = await runPaperclip("invoice.review", payload);
		return {
			...result,
			runtime: "paperclip",
			reviewedAt: new Date().toISOString(),
		};
	},

	/**
	 * A second capability, to show the card advertising more than one.
	 *
	 * Note the error boundary: a THROWN error is reported to the peer as a
	 * generic "handler failed" and the real message is logged locally, so an
	 * internal stack trace never crosses a trust boundary. To send a message that
	 * is part of the contract, throw `AgxPublicError` from `@nostr-agx/core` instead —
	 * its message is forwarded verbatim.
	 */
	"invoice.approve": async (payload) => {
		if (!payload.invoiceId) {
			throw new Error("invoiceId is required");
		}
		return {
			invoiceId: payload.invoiceId,
			status: "approved",
			runtime: "paperclip",
			approvedAt: new Date().toISOString(),
		};
	},
};
