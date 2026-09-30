import { createServer, type Server } from "node:http";
import {
	createServer as createTlsServer,
	type Server as TlsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/**
 * A minimal in-process NIP-01 relay for local development.
 *
 * Why not a real relay in Docker: a client that dials `wss://` only needs TLS,
 * and neither nostr-rs-relay nor strfry terminates it, so a real relay drags in a
 * proxy and a self-signed CA — infrastructure that tests transport security
 * rather than the exchange flow.
 * This serves plain `ws`; a host that requires `wss://` pairs it with a
 * WebSocket implementation that downgrades `wss://localhost` (localhost only, so
 * it cannot mask a scheme bug against a real host).
 *
 * Implements only what `@nostr-agx/nostr`'s relay pool uses: EVENT publish with an OK
 * reply, REQ with filters + EOSE, CLOSE, and NIP-40 (expired events are not
 * served). It is a permissive fake: no kind allow-list, no NIP-13 proof-of-work
 * or expiration-required check — those belong to a production relay's write
 * policy. Notably it does NOT implement
 * replaceable-event semantics for kind 11337, nor does it apply kind-5
 * deletions — whether a given relay honours a deletion is not ours to decide,
 * which is exactly why a de-list is reported as "requested".
 */

export interface RelayEvent {
	id: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
	sig: string;
}

interface Filter {
	ids?: string[];
	kinds?: number[];
	authors?: string[];
	since?: number;
	until?: number;
	limit?: number;
	[tagFilter: string]: unknown;
}

/** NIP-40: a relay must not serve an event past its `expiration`. Every AGX
 * gift wrap carries one, so without this a local run would keep delivering
 * what production has already purged. */
function isExpired(ev: RelayEvent): boolean {
	const tag = ev.tags.find((t) => t[0] === "expiration");
	const at = tag ? Number(tag[1]) : Number.NaN;
	return Number.isFinite(at) && at <= Math.floor(Date.now() / 1000);
}

function matches(filter: Filter, ev: RelayEvent): boolean {
	if (isExpired(ev)) {
		return false;
	}
	if (filter.ids && !filter.ids.includes(ev.id)) {
		return false;
	}
	if (filter.kinds && !filter.kinds.includes(ev.kind)) {
		return false;
	}
	if (filter.authors && !filter.authors.includes(ev.pubkey)) {
		return false;
	}
	if (typeof filter.since === "number" && ev.created_at < filter.since) {
		return false;
	}
	if (typeof filter.until === "number" && ev.created_at > filter.until) {
		return false;
	}
	// Tag filters (`#p`, `#e`, …) — the exchange polls its inbox by `#p`, so this
	// is not optional decoration.
	for (const [key, value] of Object.entries(filter)) {
		if (!key.startsWith("#") || !Array.isArray(value)) {
			continue;
		}
		const tagName = key.slice(1);
		const hit = ev.tags.some(
			(t) => t[0] === tagName && (value as string[]).includes(t[1] ?? ""),
		);
		if (!hit) {
			return false;
		}
	}
	return true;
}

export interface RelayOptions {
	port?: number;
	/** Also serve `wss://` on `tlsPort` using this key pair. */
	tls?: { cert: string; key: string; port: number };
	/** Called for every accepted event — powers `agx relay --verbose`. */
	onEvent?: (event: RelayEvent) => void;
	onRequest?: (filters: Filter[], matched: number) => void;
}

export interface RunningRelay {
	port: number;
	/** The `wss://` port, when TLS was requested and bound. */
	tlsPort: number | null;
	/** Addresses actually bound (127.0.0.1 always; ::1 when available). */
	addresses: string[];
	events: () => RelayEvent[];
	byAuthor: (pubkey: string, kind: number) => RelayEvent[];
	clear: () => void;
	close: () => Promise<void>;
}

function attach(
	server: Server | TlsServer,
	stored: RelayEvent[],
	options: RelayOptions,
): WebSocketServer {
	const wss = new WebSocketServer({ server });
	wss.on("connection", (socket) => {
		socket.on("message", (raw) => {
			let msg: unknown;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (!Array.isArray(msg)) {
				return;
			}
			const [verb] = msg;

			if (verb === "EVENT") {
				const ev = msg[1] as RelayEvent;
				stored.unshift(ev);
				socket.send(JSON.stringify(["OK", ev.id, true, ""]));
				options.onEvent?.(ev);
				return;
			}

			if (verb === "REQ") {
				const subId = msg[1] as string;
				const filters = msg.slice(2) as Filter[];
				let matched = 0;
				for (const filter of filters) {
					const limit = filter.limit ?? 500;
					const hits = stored
						.filter((ev) => matches(filter, ev))
						.sort((a, b) => b.created_at - a.created_at)
						.slice(0, limit);
					matched += hits.length;
					for (const ev of hits) {
						socket.send(JSON.stringify(["EVENT", subId, ev]));
					}
				}
				socket.send(JSON.stringify(["EOSE", subId]));
				options.onRequest?.(filters, matched);
				return;
			}

			if (verb === "CLOSE") {
				socket.send(JSON.stringify(["CLOSED", msg[1], ""]));
			}
		});
	});
	return wss;
}

/**
 * Bind, THEN attach the WebSocketServer — never the other way round.
 *
 * `ws` forwards the underlying server's `error` event onto the WebSocketServer.
 * Attached before the bind, a failed bind (`EAFNOSUPPORT` for `::1` on a host
 * with no IPv6) is re-emitted on a WebSocketServer with no listener, which
 * throws and kills the process — so the "best-effort" IPv6 listener took the
 * whole relay down on exactly the hosts it was meant to tolerate. Returns null
 * when the bind fails, leaving nothing attached to clean up.
 */
async function bindRelay(
	server: Server | TlsServer,
	port: number,
	host: string,
	stored: RelayEvent[],
	options: RelayOptions,
): Promise<WebSocketServer | null> {
	if (!(await listen(server, port, host))) {
		return null;
	}
	return attach(server, stored, options);
}

function listen(
	server: Server | TlsServer,
	port: number,
	host: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const onError = () => {
			server.removeListener("error", onError);
			resolve(false);
		};
		server.once("error", onError);
		server.listen(port, host, () => {
			server.removeListener("error", onError);
			resolve(true);
		});
	});
}

/**
 * Start the relay on both loopback families.
 *
 * Binding only `127.0.0.1` is fine under a test runner that dials the literal
 * address, but a long-lived relay is dialed as `localhost`, which resolves to
 * `::1` first on many machines — producing an 8-second connect timeout rather
 * than a refusal, which is a genuinely confusing way to lose an afternoon.
 * The IPv6 listener is best-effort: hosts without IPv6 simply skip it.
 */
export async function startRelay(
	options: RelayOptions = {},
): Promise<RunningRelay> {
	const stored: RelayEvent[] = [];
	const requested = options.port ?? 7447;
	const addresses: string[] = [];

	const v4 = createServer();
	const wssV4 = await bindRelay(v4, requested, "127.0.0.1", stored, options);
	if (!wssV4) {
		throw new Error(
			`Could not bind 127.0.0.1:${requested} — is another agx relay already running?`,
		);
	}
	const port = (v4.address() as AddressInfo).port;
	addresses.push(`127.0.0.1:${port}`);

	const v6 = createServer();
	const wssV6 = await bindRelay(v6, port, "::1", stored, options);
	if (wssV6) {
		addresses.push(`[::1]:${port}`);
	}

	// The TLS listener shares the SAME event store, so a card published over
	// wss:// is immediately readable over ws:// and vice versa. That is the whole
	// point: a TLS client dials wss://, the CLI dials ws://, and they must see one relay.
	let tlsV4: TlsServer | null = null;
	let tlsWss: WebSocketServer | null = null;
	let tlsV6: TlsServer | null = null;
	let tlsWssV6: WebSocketServer | null = null;
	let tlsPort: number | null = null;
	if (options.tls) {
		tlsV4 = createTlsServer({
			cert: options.tls.cert,
			key: options.tls.key,
		});
		tlsWss = await bindRelay(
			tlsV4,
			options.tls.port,
			"127.0.0.1",
			stored,
			options,
		);
		if (!tlsWss) {
			throw new Error(
				`Could not bind 127.0.0.1:${options.tls.port} for TLS — is the port already in use?`,
			);
		}
		tlsPort = (tlsV4.address() as AddressInfo).port;
		addresses.push(`127.0.0.1:${tlsPort} (wss)`);

		// Both loopback families, for the same reason as the plain listener — and
		// it matters MORE here: `localhost` resolves to `::1` first on macOS, so a
		// v4-only TLS listener refuses every `wss://localhost` dial while the plain
		// port keeps working, which looks like a TLS problem rather than a binding
		// one.
		tlsV6 = createTlsServer({
			cert: options.tls.cert,
			key: options.tls.key,
		});
		tlsWssV6 = await bindRelay(tlsV6, tlsPort, "::1", stored, options);
		if (tlsWssV6) {
			addresses.push(`[::1]:${tlsPort} (wss)`);
		}
	}

	return {
		port,
		tlsPort,
		addresses,
		events: () => [...stored],
		byAuthor: (pubkey, kind) =>
			stored
				.filter((e) => e.pubkey === pubkey && e.kind === kind)
				.sort((a, b) => b.created_at - a.created_at),
		clear: () => {
			stored.length = 0;
		},
		close: async () => {
			// A null WebSocketServer is a listener whose bind failed — nothing to shut.
			const shut = (
				wss: WebSocketServer | null,
				http: Server | TlsServer | null,
			) =>
				new Promise<void>((resolve) => {
					if (!wss || !http) {
						resolve();
						return;
					}
					for (const client of wss.clients) {
						client.terminate();
					}
					wss.close(() => http.close(() => resolve()));
				});
			await Promise.all([
				shut(wssV4, v4),
				shut(wssV6, v6),
				shut(tlsWss, tlsV4),
				shut(tlsWssV6, tlsV6),
			]);
		},
	};
}
