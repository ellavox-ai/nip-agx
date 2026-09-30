import { generateSecretKey, getPublicKey } from "nostr-tools";

/** A Nostr keypair: the secret (kept host-side) + its hex public key (the durable
 * agent identity peers are keyed by). */
export interface AgxKeypair {
	secretKey: Uint8Array;
	publicKey: string;
}

/** Generate a fresh secp256k1 keypair. */
export function generateKeypair(): AgxKeypair {
	const secretKey = generateSecretKey();
	return { secretKey, publicKey: getPublicKey(secretKey) };
}

/** Derive the hex public key for a secret key. */
export function publicKeyFromSecret(secretKey: Uint8Array): string {
	return getPublicKey(secretKey);
}

/** Encode bytes as lowercase hex (browser-safe; no Buffer). */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, "0");
	}
	return hex;
}

/** Decode a hex string to bytes (browser-safe; no Buffer). */
export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.length % 2 ? `0${hex}` : hex;
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}
