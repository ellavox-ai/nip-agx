import { describe, expect, it } from "vitest";
import { matchesCapability, selectCapablePeers } from "./capability";
import { InMemorySeenStore } from "./seen-store";

describe("matchesCapability", () => {
	it("matches an exact capability", () => {
		expect(matchesCapability(["invoice.review"], "invoice.review")).toBe(
			true,
		);
		expect(matchesCapability(["invoice.review"], "invoice.pay")).toBe(
			false,
		);
	});
	it("matches a namespace wildcard", () => {
		expect(matchesCapability(["invoice.*"], "invoice.review")).toBe(true);
		expect(matchesCapability(["invoice.*"], "payroll.run")).toBe(false);
	});
	it("matches a global wildcard", () => {
		expect(matchesCapability(["*"], "anything.at.all")).toBe(true);
	});
});

describe("selectCapablePeers", () => {
	it("keeps only peers that can service the capability", () => {
		const peers = [
			{ id: "a", capabilities: ["invoice.*"] },
			{ id: "b", capabilities: ["payroll.run"] },
			{ id: "c", capabilities: ["invoice.review"] },
		];
		expect(
			selectCapablePeers(peers, "invoice.review").map((p) => p.id),
		).toEqual(["a", "c"]);
	});
});

describe("InMemorySeenStore", () => {
	it("has() is false until add()", () => {
		const store = new InMemorySeenStore();
		expect(store.has("x")).toBe(false);
		store.add("x");
		expect(store.has("x")).toBe(true);
		expect(store.has("y")).toBe(false);
	});
	it("evicts oldest past the bound (FIFO)", () => {
		const store = new InMemorySeenStore(2);
		store.add("a");
		store.add("b");
		store.add("c"); // over bound → evicts "a"
		expect(store.has("a")).toBe(false); // evicted → treated as new
		expect(store.has("b")).toBe(true);
		expect(store.has("c")).toBe(true);
	});
});
