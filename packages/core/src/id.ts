/** A random task/correlation id. Uses platform WebCrypto (`globalThis.crypto`),
 * available in Node 16+ and browsers — no dependency. */
export function randomId(): string {
	return globalThis.crypto.randomUUID();
}
