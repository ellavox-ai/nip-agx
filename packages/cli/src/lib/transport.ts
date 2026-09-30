import type { AgxLogger } from "@nostr-agx/core";
import { NostrTransport } from "@nostr-agx/nostr";
import WebSocket from "ws";
import type { Profile } from "./config.js";
import { configError } from "./errors.js";
import type { Identity } from "./identity.js";

/**
 * Build the Nostr transport for this profile.
 *
 * `ws` is injected explicitly: Node 20 has no global WebSocket, and
 * `NostrTransport.create` registers whatever it is given process-wide.
 *
 * The relay URLs configured here are the agent's OWN, and are never SSRF-guarded
 * — only peer-advertised relays (from a NIP-65 list) and NIP-05 lookups are. So
 * a plain `ws://127.0.0.1:7447` works locally with no scheme gymnastics.
 */
export function createTransport(
	profile: Profile,
	identity: Identity,
	logger?: AgxLogger,
): Promise<NostrTransport> {
	if (profile.relays.length === 0) {
		throw configError(
			"This profile has no relays configured.",
			"agx config set relays ws://127.0.0.1:7447\n  and run a local relay with:\n    agx relay",
		);
	}
	return NostrTransport.create({
		signer: identity.signer,
		relays: profile.relays,
		ws: WebSocket,
		logger,
	});
}

/** A logger that only speaks when asked. The transport warns on undecryptable
 * events, which is noise during a demo but essential when debugging one. */
export function makeLogger(verbose: boolean): AgxLogger | undefined {
	if (!verbose) {
		return undefined;
	}
	return {
		debug: (message: string, meta?: unknown) =>
			console.error("[agx:debug]", message, meta ?? ""),
		info: (message: string, meta?: unknown) =>
			console.error("[agx:info]", message, meta ?? ""),
		warn: (message: string, meta?: unknown) =>
			console.error("[agx:warn]", message, meta ?? ""),
		error: (message: string, meta?: unknown) =>
			console.error("[agx:error]", message, meta ?? ""),
	};
}
