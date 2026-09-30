import { bytesToHex } from "./keys";

/** A random 128-bit hex id (messageId / contextId). Uses the platform WebCrypto
 * (`globalThis.crypto`), available in Node 20+ and browsers — no dependency. */
export function randomId(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}
