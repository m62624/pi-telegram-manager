import { describe, expect, it } from "vitest";
import {
	humanDuration,
	inactiveStatusCard,
	renderStatusCard,
	renderStatusText,
	type StatusInput,
} from "../../../src/modes/connect/status-card";

const base: StatusInput = {
	runtime: { mode: "personal" },
	busy: false,
};

describe("renderStatusCard", () => {
	it("reports what only the machine knows: model, context, directory", () => {
		const text = renderStatusCard({
			...base,
			model: { name: "Qwen3.6 35B", id: "qwen3.6-35b", provider: "llama-cpp" },
			context: { tokens: 77_000, contextWindow: 131_072, percent: 59 },
			cwd: "/home/m/Projects/pi-telegram-manager",
			thinkingLevel: "medium",
		});
		expect(text).toContain("Qwen3.6 35B (llama-cpp)");
		expect(text).toContain("~77k of 131.1k tokens (59% full)");
		expect(text).toContain("/home/m/Projects/pi-telegram-manager");
		expect(text).toContain("medium");
	});

	it("says who holds the session in mixed — the mode alone does not", () => {
		const coding = renderStatusCard({
			...base,
			runtime: { mode: "mixed", polarity: "coding" },
		});
		expect(coding).toContain("you have the session (coding)");

		const telegram = renderStatusCard({
			...base,
			runtime: { mode: "mixed", polarity: "telegram" },
		});
		expect(telegram).toContain("the manager has the session (Telegram)");
	});

	it("says whether a turn is running, and what is still waiting", () => {
		const busy = renderStatusCard({ ...base, busy: true, queued: 2 });
		expect(busy).toContain("working on a turn");
		expect(busy).toContain("2 messages");

		const idle = renderStatusCard({ ...base, busy: false, queued: 1 });
		expect(idle).toContain("idle");
		expect(idle).toContain("1 message");
		expect(idle).not.toContain("1 messages");
	});

	it("leaves the queue line out when nothing is queued", () => {
		expect(renderStatusCard({ ...base, queued: 0 })).not.toContain("Queued");
	});

	it("counts the manager's chats by what is actually happening to them", () => {
		const text = renderStatusCard({
			...base,
			runtime: { mode: "manager" },
			manager: { activeChat: "555", queued: 2, holding: 1 },
		});
		expect(text).toContain("1 being answered");
		expect(text).toContain("2 queued");
		// "Holding" is the owner's own 5-minute window — the chat is waiting for THEM.
		expect(text).toContain("1 waiting for you");

		const quiet = renderStatusCard({
			...base,
			runtime: { mode: "manager" },
			manager: { queued: 0, holding: 0 },
		});
		expect(quiet).toContain("nothing pending");
	});

	// --- and now the part that matters: it never invents anything ---------------

	it("omits a value Pi did not report, rather than guessing at it", () => {
		// A status line nobody can trust is worse than a shorter one that is all true.
		const text = renderStatusCard(base);
		expect(text).not.toContain("Model");
		expect(text).not.toContain("Context");
		expect(text).not.toContain("Working in");
		expect(text).not.toContain("Session");
		expect(text).not.toContain("Thinking");
		expect(text).not.toContain("unknown");
		// What it always knows, it always says.
		expect(text).toContain("Personal");
		expect(text).toContain("idle");
	});

	it("shows a token count with no percentage, when that is all Pi has", () => {
		// Right after a compaction Pi reports tokens as null until the next response.
		const unknown = renderStatusCard({
			...base,
			context: { tokens: null, contextWindow: 131_072, percent: null },
		});
		expect(unknown).not.toContain("Context");

		const partial = renderStatusCard({
			...base,
			context: { tokens: 12_000, contextWindow: 131_072, percent: null },
		});
		expect(partial).toContain("~12k of 131.1k tokens");
		expect(partial).not.toContain("%");
	});

	it("never lets a value it merely passes through look like a command", () => {
		// Our cards are sent with entity detection ON, so a bare "/switch" in them is a
		// button. Values we did not write — a path, a session name — must not be able to
		// smuggle one in: they are shown as code, where Telegram detects nothing.
		const text = renderStatusCard({
			...base,
			cwd: "/srv/pi",
			sessionName: "/stop me",
		});
		expect(text).toContain("`/srv/pi`");
		expect(text).toContain("`/stop me`");
		// A backtick in the value cannot break out of the span it is quoted in.
		expect(renderStatusCard({ ...base, sessionName: "a`/stop`b" })).toContain(
			"`a'/stop'b`",
		);
	});

	it("names the model even when only an id came back", () => {
		const text = renderStatusCard({ ...base, model: { id: "qwen3.6-35b" } });
		expect(text).toContain("qwen3.6-35b");

		// A model object with nothing usable in it is not a model line.
		expect(renderStatusCard({ ...base, model: { name: "  " } })).not.toContain(
			"Model",
		);
	});
});

describe("humanDuration", () => {
	it("scales to what the reader actually wants to know", () => {
		expect(humanDuration(30_000)).toBe("less than a minute");
		expect(humanDuration(3 * 60_000)).toBe("3m");
		expect(humanDuration(60 * 60_000)).toBe("1h");
		expect(humanDuration(134 * 60_000)).toBe("2h 14m");
		expect(humanDuration(27 * 60 * 60_000)).toBe("1d 3h");
		expect(humanDuration(48 * 60 * 60_000)).toBe("2d");
	});
});

describe("renderStatusText", () => {
	it("says the same thing without the markdown, for the manager's plain DM", () => {
		const input: StatusInput = {
			...base,
			runtime: { mode: "manager" },
			cwd: "/srv/pi",
			busy: true,
		};
		const text = renderStatusText(input);
		expect(text).toContain("Secretary manager");
		expect(text).toContain("/srv/pi");
		expect(text).toContain("working on a turn");
		// No Markdown punctuation left to arrive as literal asterisks and backticks.
		expect(text).not.toContain("**");
		expect(text).not.toContain("`");
	});
});

describe("inactiveStatusCard", () => {
	it("says nothing is running, and what starts something", () => {
		const text = inactiveStatusCard();
		expect(text).toContain("No Telegram mode is running");
		expect(text).toContain("/switch");
	});
});
