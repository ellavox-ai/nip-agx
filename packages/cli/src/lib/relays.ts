import { isIP } from "node:net";
import { warn } from "./output.js";

/** Matches `nostrRelaysSchema.max(20)` on the index. Truncating here keeps an
 * over-long profile from failing the listing create — for `agx register`, at
 * the END of the proof-of-possession round trip. */
export const MAX_LISTABLE_RELAYS = 20;

/**
 * The profile relays worth advertising on a listing. An agent's address is
 * pubkey + relays, so a listing without them is reachable only by a peer that
 * happens to share a relay. The index accepts public `wss://` relays only (at
 * most {@link MAX_LISTABLE_RELAYS}), and the default profile relay is a local
 * `agx relay` (`ws://127.0.0.1:7447`), so anything else is left off the listing
 * — with a warning — rather than failing the whole create.
 */
export function advertisableRelays(relays: readonly string[]): {
	advertised: string[];
	skipped: string[];
} {
	const wss: string[] = [];
	const skipped: string[] = [];
	for (const relay of relays) {
		(isListableRelay(relay) ? wss : skipped).push(relay);
	}
	const unique = [...new Set(wss)];
	return {
		advertised: unique.slice(0, MAX_LISTABLE_RELAYS),
		skipped: [...skipped, ...unique.slice(MAX_LISTABLE_RELAYS)],
	};
}

/** IPv4 loopback, RFC-1918, link-local and CGNAT ranges. */
const PRIVATE_IPV4 =
	/^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Scheme AND host. The index runs `assertPublicUrl` on every relay it stores,
 * so a `wss://` relay on a loopback or private host is a 422 — for
 * `agx register`, one that lands AFTER the proof round trip. This catches the
 * obvious local hosts without re-implementing DNS resolution; a public name
 * that resolves privately is still left to the server. Deliberately a SUBSET of
 * the server's literal list (no 192.0.0.0/24, 198.18.0.0/15, multicast,
 * reserved or 6to4): it only has to catch what a local dev setup produces, and
 * anything it misses still fails safely at the server.
 */
function isListableRelay(relay: string): boolean {
	let url: URL;
	try {
		url = new URL(relay);
	} catch {
		return false;
	}
	if (url.protocol !== "wss:") {
		return false;
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) {
		return false;
	}
	// Everything below is an IP-LITERAL rule, so it only applies to literals:
	// `fdrelay.example.com` is a DNS name, not fd00::/7. A public name that
	// resolves privately is still left to the server's resolving guard.
	if (isIP(host) === 6) {
		// fe80::/10 is fe80–febf, matching the server's `/^fe[89ab]/`.
		return !(
			host === "::1" ||
			host === "::" ||
			/^(fc|fd|fe[89ab])/.test(host)
		);
	}
	if (isIP(host) === 4) {
		return !PRIVATE_IPV4.test(host);
	}
	return true;
}

/** {@link advertisableRelays}, warning about whatever is left off.
 * `emptyRemediation` replaces the "set your profile relays" advice when the
 * profile's relays are not the listed key's address (an empty list there
 * means "pass --relay", not "configure the profile"). */
export function relaysForListing(
	relays: readonly string[],
	emptyRemediation = "Set one with:  agx config set relays wss://relay.example.com",
): string[] {
	const { advertised, skipped } = advertisableRelays(relays);
	if (skipped.length > 0) {
		warn(
			`Not advertising ${skipped.join(", ")} on the listing: only public wss:// relays can be listed, and at most ${MAX_LISTABLE_RELAYS}.`,
		);
	}
	if (advertised.length === 0) {
		warn(
			`The listing will advertise no relays, so peers can reach this agent only if they share a relay with it. ${emptyRemediation}`,
		);
	}
	return advertised;
}
