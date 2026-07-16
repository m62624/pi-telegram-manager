import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../src/pi/sdk";
import {
	buildResumeKeyboard,
	isResumeCommand,
	parseResumeCallback,
	resumeButtonLabel,
	resumePageCount,
} from "../../src/telegram/resume-panel";

function info(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/s/${id}.jsonl`,
		id,
		cwd: "/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 2,
		firstMessage: `chat ${id}`,
		allMessagesText: "",
		...over,
	};
}

/** N sessions, oldest→newest, so recency ordering is observable. */
function sessions(n: number): SessionInfo[] {
	return Array.from({ length: n }, (_, i) =>
		info(`s${i}`, {
			modified: new Date(2026, 0, 1, 0, i),
			firstMessage: `chat ${i}`,
		}),
	);
}

const texts = (kb: { inline_keyboard: { text: string }[][] }) =>
	kb.inline_keyboard.map((row) => row.map((b) => b.text));

describe("isResumeCommand", () => {
	it("matches /resume, bare or addressed, and nothing else", () => {
		expect(isResumeCommand("/resume")).toBe(true);
		expect(isResumeCommand("  /resume@my_bot ")).toBe(true);
		expect(isResumeCommand("/resumes")).toBe(false);
		expect(isResumeCommand("resume")).toBe(false);
	});
});

describe("buildResumeKeyboard", () => {
	it("leads with Current and New, then up to 5 resume rows, newest first", () => {
		const kb = buildResumeKeyboard(sessions(3), "none");
		const rows = texts(kb);
		expect(rows[0]).toEqual(["● Current session"]);
		expect(rows[1]).toEqual(["＋ New session"]);
		// Resume rows carry the cleaned preview (a time prefix rides along too).
		expect(rows[2]?.[0]).toContain("chat 2");
		expect(rows[3]?.[0]).toContain("chat 1");
		expect(rows[4]?.[0]).toContain("chat 0");
		// No nav row on a single page.
		expect(kb.inline_keyboard).toHaveLength(5);
	});

	it("excludes the current session from the resume rows", () => {
		const kb = buildResumeKeyboard(sessions(3), "s1");
		const picks = kb.inline_keyboard
			.flat()
			.filter((b) => b.callback_data?.startsWith("resume:pick:"));
		expect(picks.map((b) => b.callback_data)).toEqual([
			"resume:pick:s2",
			"resume:pick:s0",
		]);
	});

	it("paginates by 5 with the right nav buttons on each page", () => {
		const s = sessions(7); // → 2 pages of resume rows
		const page0 = buildResumeKeyboard(s, "none", 0);
		const nav0 = page0.inline_keyboard.at(-1);
		expect(nav0?.map((b) => b.text)).toEqual(["Next ▶"]);
		// 5 resume rows on page 0 (plus Current, New, nav).
		expect(page0.inline_keyboard).toHaveLength(2 + 5 + 1);

		const page1 = buildResumeKeyboard(s, "none", 1);
		const nav1 = page1.inline_keyboard.at(-1);
		expect(nav1?.map((b) => b.text)).toEqual(["◀ Prev"]);
		expect(page1.inline_keyboard).toHaveLength(2 + 2 + 1);
	});

	it("clamps an out-of-range page instead of showing an empty one", () => {
		const s = sessions(7);
		expect(buildResumeKeyboard(s, "none", 99)).toEqual(
			buildResumeKeyboard(s, "none", 1),
		);
	});
});

describe("resumeButtonLabel", () => {
	it("leads with the time stamp and shows the body, not the Telegram framing", () => {
		const label = resumeButtonLabel(
			info("s", {
				modified: new Date("2026-07-16T17:35:00Z"),
				firstMessage:
					"[telegram|from:Alice|at:Thu 2026-07-16 17:35]\n\nhey are you around?",
			}),
		);
		expect(label.startsWith("07-16 17:35")).toBe(true);
		expect(label).toContain("hey are you around?");
		expect(label).not.toContain("[telegram");
	});
});

describe("resumePageCount", () => {
	it("is at least one, and grows every five resumable sessions", () => {
		expect(resumePageCount([], "none")).toBe(1);
		expect(resumePageCount(sessions(5), "none")).toBe(1);
		expect(resumePageCount(sessions(6), "none")).toBe(2);
	});
});

describe("parseResumeCallback", () => {
	it("parses each of our actions", () => {
		expect(parseResumeCallback("resume:current")).toEqual({ kind: "current" });
		expect(parseResumeCallback("resume:new")).toEqual({ kind: "new" });
		expect(parseResumeCallback("resume:page:2")).toEqual({
			kind: "page",
			page: 2,
		});
		expect(parseResumeCallback("resume:pick:abc-123")).toEqual({
			kind: "pick",
			id: "abc-123",
		});
	});

	it("rejects foreign, malformed, or empty data", () => {
		expect(parseResumeCallback(undefined)).toBeNull();
		expect(parseResumeCallback("switch:personal")).toBeNull();
		expect(parseResumeCallback("resume:page:x")).toBeNull();
		expect(parseResumeCallback("resume:page:-1")).toBeNull();
		expect(parseResumeCallback("resume:pick:")).toBeNull();
	});
});
