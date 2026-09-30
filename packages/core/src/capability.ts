/**
 * Capability matching. A responder advertises the capability keys it handles (on
 * its Agent Card); an initiator checks whether a peer can service a requested
 * capability before sending. Keys are dot-namespaced (e.g. `invoice.review`);
 * a `*` suffix advertises a namespace wildcard (`invoice.*` matches `invoice.x`).
 */

/** Whether `advertised` (a peer's card capabilities) can service `requested`. */
export function matchesCapability(
	advertised: readonly string[],
	requested: string,
): boolean {
	for (const cap of advertised) {
		// Defense-in-depth: `advertised` may derive from a peer's card. A non-string
		// element would make `.endsWith` throw and take down the whole match.
		if (typeof cap !== "string") {
			continue;
		}
		if (cap === requested) {
			return true;
		}
		if (cap.endsWith(".*")) {
			const prefix = cap.slice(0, -1); // keep the trailing dot: "invoice."
			if (requested.startsWith(prefix)) {
				return true;
			}
		}
		if (cap === "*") {
			return true;
		}
	}
	return false;
}

/** Pick the peers (by index) whose advertised capabilities can service `requested`. */
export function selectCapablePeers<
	T extends { capabilities: readonly string[] },
>(peers: readonly T[], requested: string): T[] {
	return peers.filter((p) => matchesCapability(p.capabilities, requested));
}
