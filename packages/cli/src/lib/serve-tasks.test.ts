import {
	DEFAULT_CONTENT_TYPE,
	encodeTaskEnvelope,
	TASK_CONTENT_TYPE,
} from "@nostr-agx/core";
import { describe, expect, it } from "vitest";
import {
	capabilitiesToServe,
	DEFAULT_CAPABILITY,
	noTasksConflicts,
	servesPing,
	UNANSWERED_TASK_REQUEST_NOTE,
	UNHANDLED_TASK_MESSAGE_NOTE,
	unservedTaskNote,
} from "./serve-tasks";

describe("capabilitiesToServe", () => {
	it("falls back to the built-in stand-in when nothing is named", () => {
		expect(capabilitiesToServe({}, [])).toEqual([DEFAULT_CAPABILITY]);
		expect(capabilitiesToServe({ tasks: true }, [])).toEqual([
			DEFAULT_CAPABILITY,
		]);
	});

	it("uses the handler module's keys", () => {
		expect(capabilitiesToServe({}, ["a.one", "a.two"])).toEqual([
			"a.one",
			"a.two",
		]);
	});

	it("prefers explicit --capability over the handler keys", () => {
		expect(capabilitiesToServe({ capability: ["x.y"] }, ["a.one"])).toEqual(
			["x.y"],
		);
	});

	it("serves nothing under --no-tasks, not even the stand-in", () => {
		expect(capabilitiesToServe({ tasks: false }, [])).toEqual([]);
		expect(capabilitiesToServe({ tasks: false }, ["a.one"])).toEqual([]);
	});
});

describe("servesPing", () => {
	it("serves agx.ping unless --no-tasks", () => {
		expect(servesPing({})).toBe(true);
		expect(servesPing({ tasks: true })).toBe(true);
		expect(servesPing({ tasks: false })).toBe(false);
	});
});

describe("noTasksConflicts", () => {
	it("reports nothing when tasks are on, whatever else is set", () => {
		expect(
			noTasksConflicts({
				capability: ["x"],
				handler: "./h.mjs",
				advertise: true,
				allowAll: true,
			}),
		).toEqual([]);
	});

	it("reports nothing for --no-tasks alone", () => {
		expect(noTasksConflicts({ tasks: false })).toEqual([]);
	});

	it("rejects every flag that only means something when tasks are served", () => {
		const conflicts = noTasksConflicts({
			tasks: false,
			capability: ["x"],
			handler: "./h.mjs",
			advertise: true,
			allowAll: true,
		});
		expect(conflicts).toHaveLength(4);
		expect(conflicts.join("\n")).toMatch(/--capability/);
		expect(conflicts.join("\n")).toMatch(/--handler/);
		expect(conflicts.join("\n")).toMatch(/--advertise/);
		expect(conflicts.join("\n")).toMatch(/--allow-all/);
	});

	it("ignores an empty --capability list", () => {
		expect(noTasksConflicts({ tasks: false, capability: [] })).toEqual([]);
	});
});

describe("unservedTaskNote", () => {
	const request = encodeTaskEnvelope({
		t: "req",
		taskId: "t-1",
		capability: "invoice.review",
		payload: { amount: 1 },
	});
	const result = encodeTaskEnvelope({
		t: "res",
		taskId: "t-1",
		status: "completed",
		output: { ok: true },
	});
	const off = { tasks: false };

	it("labels a parsed task request as not answered", () => {
		expect(
			unservedTaskNote(off, {
				contentType: TASK_CONTENT_TYPE,
				text: request,
			}),
		).toBe(UNANSWERED_TASK_REQUEST_NOTE);
		expect(UNANSWERED_TASK_REQUEST_NOTE).toBe(
			"(typed task request — --no-tasks: not answered)",
		);
	});

	it("labels a stray result or a malformed envelope as a task message, not a request", () => {
		for (const text of [
			result,
			"not json",
			'{"t":"req"}',
			'{"t":"other","taskId":"x"}',
			"",
		]) {
			expect(
				unservedTaskNote(off, { contentType: TASK_CONTENT_TYPE, text }),
			).toBe(UNHANDLED_TASK_MESSAGE_NOTE);
		}
		expect(UNHANDLED_TASK_MESSAGE_NOTE).toBe(
			"(typed task message — --no-tasks: not handled)",
		);
	});

	it("prints nothing for a plain message, even one whose text is a request envelope", () => {
		expect(
			unservedTaskNote(off, {
				contentType: DEFAULT_CONTENT_TYPE,
				text: request,
			}),
		).toBeNull();
	});

	it("prints nothing when tasks are on", () => {
		for (const flags of [{}, { tasks: true }]) {
			expect(
				unservedTaskNote(flags, {
					contentType: TASK_CONTENT_TYPE,
					text: request,
				}),
			).toBeNull();
		}
	});
});
