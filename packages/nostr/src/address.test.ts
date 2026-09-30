import { describe, expect, it } from "vitest";
import { normalizePubkey, shortIdentity, toNpub } from "./address";
import { generateKeypair } from "./keys";

describe("normalizePubkey", () => {
	const { publicKey: hex } = generateKeypair();
	const npub = toNpub(hex);

	it("accepts a 64-char hex pubkey (lowercased)", () => {
		expect(normalizePubkey(hex.toUpperCase())).toBe(hex);
		expect(normalizePubkey(`  ${hex}  `)).toBe(hex);
	});

	it("decodes an npub back to hex", () => {
		expect(normalizePubkey(npub)).toBe(hex);
	});

	it("rejects non-identities", () => {
		expect(normalizePubkey("acme/support")).toBeNull();
		expect(normalizePubkey("https://evil.com/card.json")).toBeNull();
		expect(normalizePubkey("npub1notvalid")).toBeNull();
		expect(normalizePubkey("")).toBeNull();
	});
});

describe("shortIdentity", () => {
	it("prefers NIP-05 when present", () => {
		const { publicKey } = generateKeypair();
		expect(shortIdentity(publicKey, "alice@partner.com")).toBe(
			"alice@partner.com",
		);
	});

	it("falls back to a truncated npub", () => {
		const { publicKey } = generateKeypair();
		const label = shortIdentity(publicKey, null);
		expect(label.startsWith("npub1")).toBe(true);
		expect(label).toContain("…");
	});
});
