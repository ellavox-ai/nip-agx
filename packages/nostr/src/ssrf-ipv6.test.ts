import { describe, expect, it, vi } from "vitest";

// Mock DNS so a hostname resolves to a chosen IPv6 address. The IPv6 branch is
// otherwise unreachable in a test: a bracketed literal (`wss://[::1]`) falls to
// the DNS path (and fails there), so only a resolver result exercises it.
const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
	lookup: (...a: unknown[]) => mockLookup(...a),
}));

import { assertPublicUrl } from "./ssrf";

const wss = { protocols: ["wss:"] };

function resolvesTo(address: string) {
	mockLookup.mockResolvedValue([
		{ address, family: address.includes(":") ? 6 : 4 },
	]);
}

describe("assertPublicUrl IPv6 classification (DNS-resolved)", () => {
	it("rejects fe80::/10 link-local beyond the exact fe80 prefix", async () => {
		for (const a of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
			resolvesTo(a);
			expect(
				(await assertPublicUrl("wss://host.example", wss)).ok,
				a,
			).toBe(false);
		}
	});

	it("rejects loopback (compressed + expanded) and unique-local", async () => {
		for (const a of ["::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1"]) {
			resolvesTo(a);
			expect(
				(await assertPublicUrl("wss://host.example", wss)).ok,
				a,
			).toBe(false);
		}
	});

	it("rejects an IPv4-mapped private address", async () => {
		resolvesTo("::ffff:10.0.0.1");
		expect((await assertPublicUrl("wss://host.example", wss)).ok).toBe(
			false,
		);
	});

	it("accepts a public IPv6 address", async () => {
		resolvesTo("2606:4700::1111"); // Cloudflare
		expect((await assertPublicUrl("wss://host.example", wss)).ok).toBe(
			true,
		);
	});
});
