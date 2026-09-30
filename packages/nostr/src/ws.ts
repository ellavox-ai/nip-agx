import { useWebSocketImplementation } from "nostr-tools/relay";

/**
 * WebSocket injection. nostr-tools uses the global `WebSocket` in browsers/edge,
 * but Node has none — the host injects one (`ws`). Call once before dialing.
 */

/** A WHATWG-compatible WebSocket constructor (e.g. the Node `ws` package's
 * default export, or the browser/edge global). nostr-tools' setter is untyped, so
 * this stays structural. */
export type WebSocketImpl = unknown;

let configured = false;

/** Configure the WebSocket implementation for relay connections. Pass a Node `ws`
 * constructor; omit in a browser/edge runtime where a global `WebSocket` exists.
 * Idempotent — a repeat call with the same intent is a no-op. */
export function configureWebSocket(impl?: WebSocketImpl): void {
	if (impl) {
		useWebSocketImplementation(
			impl as Parameters<typeof useWebSocketImplementation>[0],
		);
		configured = true;
		return;
	}
	if (configured) {
		return;
	}
	if (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined"
	) {
		// A global WebSocket exists (browser/edge/Node 21+) — nostr-tools uses it.
		configured = true;
	}
}
