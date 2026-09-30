import {
	type Event,
	type EventTemplate,
	finalizeEvent,
	getPublicKey,
	nip44,
} from "nostr-tools";

/**
 * Everything this binding needs from an identity's secret key, and nothing more.
 *
 * The method names and shapes are NIP-07's (`window.nostr`) and NIP-46's remote
 * signer — deliberately, so a browser extension, a KMS-backed signer or a NIP-46
 * bunker drops in without an adapter, and the secret key never has to exist in
 * the process that talks to relays. Every operation that used to take a raw
 * `Uint8Array` goes through this instead; {@link localSigner} is the in-process
 * implementation for hosts that do hold the key.
 *
 * All four are async because the remote implementations are, even though the
 * local one is not.
 */
export interface AgxSigner {
	/** Hex public key of the identity this signer acts for. */
	getPublicKey(): Promise<string>;
	/** Fill in `pubkey`/`id`/`sig` for `template` and return the signed event. */
	signEvent(template: EventTemplate): Promise<Event>;
	/** NIP-44 v2 encrypt `plaintext` to `peerPubkey`. */
	nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
	/** NIP-44 v2 decrypt a `ciphertext` that `peerPubkey` encrypted to us. Throws
	 * on a bad MAC / malformed payload, like the underlying primitive. */
	nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}

/**
 * What a signer rejects with when it could not be REACHED — a bunker offline, a
 * KMS timeout, an extension that refused to answer — as opposed to being handed
 * input that does not check out.
 *
 * The distinction is load-bearing for polling: a wrap that fails to open is
 * recorded as discarded and never retried, which is right for junk and wrong
 * for an outage — that would throw away every real message in the window.
 * Remote signers MUST reject with this (or an error whose `name` matches) when
 * the failure says nothing about the input; any other rejection is taken to
 * mean the input was bad. {@link localSigner} never throws it.
 */
export class AgxSignerUnavailableError extends Error {
	constructor(message = "AGX signer unavailable", options?: ErrorOptions) {
		super(message, options);
		this.name = "AgxSignerUnavailableError";
	}
}

/** True for an {@link AgxSignerUnavailableError}. Also matches by `name`, so an
 * error from a second copy of this package (dual ESM/CJS, or a signer shipped
 * as its own bundle) is still recognised. */
export function isSignerUnavailable(
	err: unknown, // any rejection reason; narrowed here
): err is AgxSignerUnavailableError {
	return (
		err instanceof AgxSignerUnavailableError ||
		(err instanceof Error && err.name === "AgxSignerUnavailableError")
	);
}

/** Bounds the per-signer conversation-key cache. An ingest batch touches a
 * handful of real peers; this stops a long-lived CLI `serve` — and the stream
 * of one-time gift-wrap keys — from growing the map without limit. */
const MAX_CACHED_CONVERSATION_KEYS = 256;

/**
 * An {@link AgxSigner} over a secret key held in this process.
 *
 * Conversation keys are cached per peer (deriving one is an ECDH plus an HKDF),
 * which pays off for the few REAL peers: every seal we open from a given sender,
 * and everything we encrypt to them, uses the same key. It does nothing for a
 * gift wrap's outer layer, which is keyed by a one-time pubkey that never
 * recurs — so eviction is least-recently-used, letting those single-use
 * entries age out past the hot per-sender keys instead of flushing them.
 */
export function localSigner(secretKey: Uint8Array): AgxSigner {
	const publicKey = getPublicKey(secretKey);
	const conversationKeys = new Map<string, Uint8Array>();
	function conversationKey(peerPubkey: string): Uint8Array {
		const hit = conversationKeys.get(peerPubkey);
		if (hit) {
			// Re-insert: a Map iterates in insertion order, so this moves the key to
			// the most-recently-used end.
			conversationKeys.delete(peerPubkey);
			conversationKeys.set(peerPubkey, hit);
			return hit;
		}
		const key = nip44.getConversationKey(secretKey, peerPubkey);
		if (conversationKeys.size >= MAX_CACHED_CONVERSATION_KEYS) {
			const oldest = conversationKeys.keys().next().value;
			if (oldest !== undefined) {
				conversationKeys.delete(oldest);
			}
		}
		conversationKeys.set(peerPubkey, key);
		return key;
	}
	return {
		getPublicKey: () => Promise.resolve(publicKey),
		signEvent: (template) =>
			Promise.resolve(finalizeEvent(template, secretKey)),
		// Promise executors, so a THROW (bad peer key, oversize plaintext, bad MAC)
		// surfaces as a rejection — the same way a remote signer's failure would.
		nip44Encrypt: (peerPubkey, plaintext) =>
			new Promise((resolve) =>
				resolve(nip44.encrypt(plaintext, conversationKey(peerPubkey))),
			),
		nip44Decrypt: (peerPubkey, ciphertext) =>
			new Promise((resolve) =>
				resolve(nip44.decrypt(ciphertext, conversationKey(peerPubkey))),
			),
	};
}
