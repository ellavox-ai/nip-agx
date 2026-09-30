import { normalizePubkey, toNpub } from "@nostr-agx/nostr";
import { usageError } from "./errors.js";

/** Peer identity input is always accepted as npub or hex and normalized to hex
 * immediately — `authorize`'s `from` is raw hex, so comparing anything else
 * silently never matches, which is the worst possible failure for an allowlist. */
export function toHexPubkey(input: string, label = "identity"): string {
	const hex = normalizePubkey(input.trim());
	if (!hex) {
		throw usageError(
			`"${input}" is not a valid ${label} — expected an npub1… or a 64-character hex pubkey.`,
		);
	}
	return hex;
}

export function toDisplayNpub(hexOrNpub: string): string {
	const hex = normalizePubkey(hexOrNpub);
	return hex ? toNpub(hex) : hexOrNpub;
}
