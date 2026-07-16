import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../src/pi/sdk";
import {
	buildSessionPickerOptions,
	isSessionEmpty,
	resolveSessionPick,
	SESSION_PICKER_PAGE_SIZE,
	sessionLabel,
	sessionPickerPageCount,
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

	it("strips the Telegram meta header so the real body shows, not the framing", () => {
		const firstMessage =
			'[telegram|from:Alice|chat:General|at:Mon 2026-07-10 14:32 +05:00]\n[reply to Ada]: "earlier"\n[attachments: photo]\n\nhey are you around?';
		expect(
			sessionLabel({ name: undefined, firstMessage, messageCount: 4 }),
		).toBe("hey are you around?");
	});

	it("falls back to a generic preview when only meta lines remain", () => {
		expect(
			sessionLabel({
				name: undefined,
				firstMessage: "[telegram|from:Alice|at:now]",
				messageCount: 2,
			}),
		).toBe("(no preview)");
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

describe("buildSessionPickerOptions / resolveSessionPick", () => {
	it("leads with Current and New, then the others newest first", () => {
		const current = info({ id: "cur", firstMessage: "current work" });
		const older = info({
			id: "old",
			path: "/s/old.jsonl",
			firstMessage: "old chat",
			modified: new Date("2026-01-01T00:00:00Z"),
		});
		const newer = info({
			id: "new",
			path: "/s/new.jsonl",
			firstMessage: "new chat",
			modified: new Date("2026-02-01T00:00:00Z"),
		});
		const options = buildSessionPickerOptions([older, current, newer], "cur");

		expect(options.map((o) => o.pick)).toEqual([
			{ kind: "current" },
			{ kind: "new" },
			{ kind: "resume", path: "/s/new.jsonl" },
			{ kind: "resume", path: "/s/old.jsonl" },
		]);
	});

	it("omits the current session from the resume rows (it is already Current)", () => {
		const options = buildSessionPickerOptions(
			[info({ id: "cur", path: "/s/cur.jsonl" })],
			"cur",
		);
		expect(options).toHaveLength(2); // Current + New only
		expect(options.some((o) => o.pick.kind === "resume")).toBe(false);
	});

	it("resolves a selected label back to its choice, and a stranger to null", () => {
		const options = buildSessionPickerOptions(
			[info({ id: "x", path: "/s/x.jsonl", firstMessage: "fix login" })],
			"cur",
		);
		const resumeRow = options[2];
		expect(resolveSessionPick(options, resumeRow.label)).toEqual({
			kind: "resume",
			path: "/s/x.jsonl",
		});
		expect(resolveSessionPick(options, "● Current session")).toEqual({
			kind: "current",
		});
		expect(resolveSessionPick(options, "not a row")).toBeNull();
	});

	it("stamps each resume row with a time, so same-preview sessions stay distinct", () => {
		const a = info({
			id: "a",
			path: "/s/a.jsonl",
			firstMessage: "same",
			modified: new Date("2026-03-04T09:05:00Z"),
		});
		const b = info({
			id: "b",
			path: "/s/b.jsonl",
			firstMessage: "same",
			modified: new Date("2026-03-04T10:06:00Z"),
		});
		const options = buildSessionPickerOptions([a, b], "cur");
		const labels = options.slice(2).map((o) => o.label);
		expect(new Set(labels).size).toBe(2);
		expect(labels[0]).toContain("03-04 10:06");
	});
});

describe("session picker pagination", () => {
	/** `count` resumable sessions plus a distinct current one, newest first by index. */
	function roster(count: number): SessionInfo[] {
		return Array.from({ length: count }, (_, i) =>
			info({
				id: `s${i}`,
				path: `/s/${i}.jsonl`,
				firstMessage: `chat ${i}`,
				// Higher index = newer, so sort order is s(count-1) … s0.
				modified: new Date(2026, 0, 1, 0, i),
			}),
		);
	}

	it("counts pages over the resumable sessions (current excluded)", () => {
		const sessions = [
			...roster(SESSION_PICKER_PAGE_SIZE + 1),
			info({ id: "cur" }),
		];
		expect(sessionPickerPageCount(sessions, "cur")).toBe(2);
		expect(sessionPickerPageCount([info({ id: "cur" })], "cur")).toBe(1);
	});

	it("caps a page's resume rows and offers Older when more remain", () => {
		const sessions = roster(SESSION_PICKER_PAGE_SIZE + 3);
		const options = buildSessionPickerOptions(sessions, "cur", 0);
		const resumeRows = options.filter((o) => o.pick.kind === "resume");
		expect(resumeRows).toHaveLength(SESSION_PICKER_PAGE_SIZE);
		expect(options.some((o) => o.label === "▽  Older sessions")).toBe(true);
		expect(options.some((o) => o.label === "△  Newer sessions")).toBe(false);
	});

	it("shows Newer on a later page and resolves a nav row to its page", () => {
		const sessions = roster(SESSION_PICKER_PAGE_SIZE + 3);
		const options = buildSessionPickerOptions(sessions, "cur", 1);
		expect(options.filter((o) => o.pick.kind === "resume")).toHaveLength(3);
		expect(options.some((o) => o.label === "▽  Older sessions")).toBe(false);
		expect(resolveSessionPick(options, "△  Newer sessions")).toEqual({
			kind: "page",
			page: 0,
		});
	});

	it("clamps an out-of-range page to the last one", () => {
		const sessions = roster(SESSION_PICKER_PAGE_SIZE + 1);
		const options = buildSessionPickerOptions(sessions, "cur", 99);
		// Last page holds the single overflow row; only a Newer nav, no Older.
		expect(options.filter((o) => o.pick.kind === "resume")).toHaveLength(1);
		expect(options.some((o) => o.label === "△  Newer sessions")).toBe(true);
		expect(options.some((o) => o.label === "▽  Older sessions")).toBe(false);
	});

	it("adds no nav rows when everything fits on one page", () => {
		const options = buildSessionPickerOptions(roster(2), "cur", 0);
		expect(options.some((o) => o.pick.kind === "page")).toBe(false);
	});
});
