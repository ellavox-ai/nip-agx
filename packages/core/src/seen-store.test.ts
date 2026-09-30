import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEEN_RETENTION_SEC, InMemorySeenStore } from "./seen-store";

describe("InMemorySeenStore", () => {
	it("has/add tracks processed ids", () => {
		const s = new InMemorySeenStore();
		expect(s.has("a")).toBe(false);
		s.add("a");
		expect(s.has("a")).toBe(true);
	});

	it("hasMany returns the subset already seen", () => {
		const s = new InMemorySeenStore();
		s.add("a");
		s.add("c");
		expect(s.hasMany(["a", "b", "c"])).toEqual(new Set(["a", "c"]));
	});

	it("bounds the seen FIFO to `max`, evicting oldest", () => {
		const s = new InMemorySeenStore(2);
		s.add("a");
		s.add("b");
		s.add("c"); // evicts "a"
		expect(s.has("a")).toBe(false);
		expect(s.has("b")).toBe(true);
		expect(s.has("c")).toBe(true);
	});

	it("recordFailure counts per id and add() clears the counter", () => {
		const s = new InMemorySeenStore();
		expect(s.recordFailure("x")).toBe(1);
		expect(s.recordFailure("x")).toBe(2);
		s.add("x"); // terminal → counter cleared
		expect(s.recordFailure("x")).toBe(1); // starts over
	});

	it("bounds the failures map to `max` (no unbounded leak for abandoned ids)", () => {
		const s = new InMemorySeenStore(3);
		// 100 distinct ids that each fail once and are never redelivered/added.
		for (let i = 0; i < 100; i++) {
			s.recordFailure(`id-${i}`);
		}
		// The map never exceeds `max`; only the most-recent ids retain a counter.
		expect(s.recordFailure("id-99")).toBe(2); // recent id still tracked
		expect(s.recordFailure("id-0")).toBe(1); // oldest was evicted → reset
	});

	describe("retention is a time window, not a count", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("keeps an id through 10,000 later adds while it is inside the window", () => {
			// The old default was a 10k FIFO: two ids per gift-wrapped event
			// plus every junk wrap addressed to the agent evicted history still
			// inside the two-day poll window, which then re-delivered.
			const s = new InMemorySeenStore();
			s.add("early");
			for (let i = 0; i < 10_000; i++) {
				s.add(`later-${i}`);
			}
			expect(s.has("early")).toBe(true);
		});

		it("forgets an id once the retention window has passed", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const s = new InMemorySeenStore();
			s.add("old");
			vi.setSystemTime(
				new Date(
					Date.parse("2026-01-01T00:00:00Z") +
						(DEFAULT_SEEN_RETENTION_SEC - 60) * 1000,
				),
			);
			expect(s.has("old")).toBe(true);
			vi.setSystemTime(
				new Date(
					Date.parse("2026-01-01T00:00:00Z") +
						(DEFAULT_SEEN_RETENTION_SEC + 60) * 1000,
				),
			);
			expect(s.has("old")).toBe(false);
			s.add("new"); // pruning happens on write
			expect(s.hasMany(["old", "new"])).toEqual(new Set(["new"]));
		});

		it("covers the Nostr poll window with margin", () => {
			const twoDaysPlusOverlap = 2 * 24 * 60 * 60 + 120;
			expect(DEFAULT_SEEN_RETENTION_SEC).toBeGreaterThan(
				twoDaysPlusOverlap,
			);
		});
	});
});
