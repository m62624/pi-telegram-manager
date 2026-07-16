import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../src/pi/sdk";
import {
	isSessionEmpty,
	sessionLabel,
	sortSessionsByRecency,
} from "../../src/pi/session-list";

/** A SessionInfo as `SessionManager.list` returns it; only the fields we shape are set. */
function info(over: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/s/a.jsonl",
		id: "id-a",
		cwd: "/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "hello there",
		...over,
	};
}

describe("sortSessionsByRecency", () => {
	it("orders newest first by modified time", () => {
		const older = info({
			id: "old",
			modified: new Date("2026-01-01T00:00:00Z"),
		});
		const newer = info({
			id: "new",
			modified: new Date("2026-03-01T00:00:00Z"),
		});
		const mid = info({ id: "mid", modified: new Date("2026-02-01T00:00:00Z") });
		expect(sortSessionsByRecency([older, newer, mid]).map((s) => s.id)).toEqual(
			["new", "mid", "old"],
		);
	});

	it("copies rather than sorting the caller's array in place", () => {
		const a = info({ id: "a", modified: new Date("2026-01-01T00:00:00Z") });
		const b = info({ id: "b", modified: new Date("2026-02-01T00:00:00Z") });
		const input = [a, b];
		sortSessionsByRecency(input);
		expect(input.map((s) => s.id)).toEqual(["a", "b"]);
	});
});

describe("isSessionEmpty", () => {
	it("is true only when no turns were recorded", () => {
		expect(isSessionEmpty({ messageCount: 0 })).toBe(true);
		expect(isSessionEmpty({ messageCount: 1 })).toBe(false);
	});
});

describe("sessionLabel", () => {
	it("prefers the display name over the first message", () => {
		expect(
			sessionLabel(info({ name: "Release prep", firstMessage: "hi" })),
		).toBe("Release prep");
	});

	it("falls back to the first message when there is no name", () => {
		expect(
			sessionLabel(info({ name: undefined, firstMessage: "fix login" })),
		).toBe("fix login");
	});

	it("collapses internal whitespace and newlines to single spaces", () => {
		expect(
			sessionLabel(
				info({ name: undefined, firstMessage: "line one\n\n  line two" }),
			),
		).toBe("line one line two");
	});

	it("truncates with an ellipsis past the max length", () => {
		const long = "x".repeat(80);
		const label = sessionLabel(
			info({ name: undefined, firstMessage: long }),
			10,
		);
		expect(label).toHaveLength(10);
		expect(label.endsWith("…")).toBe(true);
	});

	it("names an empty session as such, and a nonempty one with no preview generically", () => {
		expect(
			sessionLabel({ name: undefined, firstMessage: "", messageCount: 0 }),
		).toBe("(empty session)");
		expect(
			sessionLabel({ name: undefined, firstMessage: "   ", messageCount: 3 }),
		).toBe("(no preview)");
	});
});
