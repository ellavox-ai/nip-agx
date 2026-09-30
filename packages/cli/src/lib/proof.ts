import type { AgxSigner } from "@nostr-agx/nostr";

/**
 * Proof of possession — the anti-squatting control.
 *
 * The index issues a nonce and accepts, as proof, ANY signed NIP-01 event whose
 * `content` contains that nonce. The verifier checks exactly three things: the
 * event's pubkey equals the claimed key, the content carries the nonce, and the
 * signature validates. Kind, `created_at` and tags are not inspected.
 *
 * One operational property worth surfacing to the user: the challenge row is
 * consumed ATOMICALLY BEFORE verification, so a failed proof burns the nonce.
 * Every retry must start from a fresh challenge.
 */

export interface SignedProofEvent {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

/** Kind 1 with the nonce in the content. Any kind is accepted; a plain note is
 * the most legible thing to show someone reading the transcript. */
export async function signNonceEvent(
	signer: AgxSigner,
	nonce: string,
): Promise<SignedProofEvent> {
	const event = await signer.signEvent({
		kind: 1,
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		content: `agent-index proof ${nonce}`,
	});
	return {
		id: event.id,
		pubkey: event.pubkey,
		created_at: event.created_at,
		kind: event.kind,
		tags: event.tags,
		content: event.content,
		sig: event.sig,
	};
}
