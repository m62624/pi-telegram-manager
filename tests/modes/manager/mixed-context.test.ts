import { describe, expect, it } from "vitest";
import {
	isTelegramTurn,
	MIXED_TELEGRAM_MARKER,
	stripTelegramTurns,
	stripTelegramTurnsFromCompaction,
	tagTelegramPrompt,
} from "../../../src/modes/manager/mixed-context";

type Msg = {
	role: string;
	content?: string | { type?: string; text?: string; name?: string }[];
	toolName?: string;
};

const user = (text: string): Msg => ({ role: "user", content: text });
const tgUser = (text: string): Msg => ({
	role: "user",
	content: tagTelegramPrompt(text),
});
const assistantText = (text: string): Msg => ({
	role: "assistant",
	content: [{ type: "text", text }],
});
const assistantToolUse = (): Msg => ({
	role: "assistant",
	content: [{ type: "tool_use", text: "" }],
});
const toolResult = (): Msg => ({
	role: "toolResult",
	content: [{ type: "text", text: "ok" }],
});

describe("mixed-context marker", () => {
	it("tags and detects a Telegram turn prompt", () => {
		const prompt = tagTelegramPrompt("Respond to the latest messages");
		expect(prompt.startsWith(MIXED_TELEGRAM_MARKER)).toBe(true);
		expect(isTelegramTurn({ role: "user", content: prompt })).toBe(true);
	});

	it("does not flag a plain coding prompt", () => {
		expect(isTelegramTurn(user("fix the bug in login"))).toBe(false);
	});

	it("only flags user messages, never assistant/tool", () => {
		expect(
			isTelegramTurn({
				role: "assistant",
				content: [{ type: "text", text: MIXED_TELEGRAM_MARKER }],
			}),
		).toBe(false);
	});

	it("detects the marker inside block-array user content", () => {
		expect(
			isTelegramTurn({
				role: "user",
				content: [{ type: "text", text: tagTelegramPrompt("hi") }],
			}),
		).toBe(true);
	});
});

describe("stripTelegramTurns", () => {
	it("removes a whole Telegram turn block (prompt + tool_use + result + prose)", () => {
		const messages: Msg[] = [
			user("write a function"),
			assistantText("done"),
			tgUser("Respond to the latest Telegram messages"),
			assistantToolUse(),
			toolResult(),
			assistantText("replied to the chat"),
			user("now add a test"),
			assistantText("added"),
		];
		const kept = stripTelegramTurns(messages);
		expect(kept).toEqual([
			user("write a function"),
			assistantText("done"),
			user("now add a test"),
			assistantText("added"),
		]);
	});

	it("keeps coding tool_use<->tool_result pairs intact", () => {
		const messages: Msg[] = [
			user("read the file"),
			assistantToolUse(),
			toolResult(),
			assistantText("here it is"),
		];
		expect(stripTelegramTurns(messages)).toEqual(messages);
	});

	it("drops trailing Telegram turns with no closing coding prompt", () => {
		const messages: Msg[] = [
			user("hello"),
			assistantText("hi"),
			tgUser("Telegram turn"),
			assistantToolUse(),
			toolResult(),
		];
		expect(stripTelegramTurns(messages)).toEqual([
			user("hello"),
			assistantText("hi"),
		]);
	});

	it("handles back-to-back Telegram turns as separate dropped blocks", () => {
		const messages: Msg[] = [
			tgUser("turn 1"),
			assistantToolUse(),
			toolResult(),
			tgUser("turn 2"),
			assistantToolUse(),
			toolResult(),
			user("owner returns"),
			assistantText("welcome back"),
		];
		expect(stripTelegramTurns(messages)).toEqual([
			user("owner returns"),
			assistantText("welcome back"),
		]);
	});

	it("returns coding-only transcript unchanged", () => {
		const messages: Msg[] = [user("a"), assistantText("b"), user("c")];
		expect(stripTelegramTurns(messages)).toEqual(messages);
	});
});

/** A manager turn's tool call and its result — what a `manager_*` turn looks like. */
const managerToolUse = (): Msg => ({
	role: "assistant",
	content: [{ type: "toolCall", name: "manager_reply" }],
});
const managerToolResult = (): Msg => ({
	role: "toolResult",
	toolName: "manager_reply",
	content: [{ type: "text", text: "sent" }],
});
const codingToolUse = (): Msg => ({
	role: "assistant",
	content: [{ type: "toolCall", name: "read" }],
});
const codingToolResult = (): Msg => ({
	role: "toolResult",
	toolName: "read",
	content: [{ type: "text", text: "…file…" }],
});

describe("stripTelegramTurns, when the transcript opens mid-turn", () => {
	// Pi's compaction cuts the history at "a user OR an assistant message, never a
	// tool result". So a cut can land INSIDE a manager turn, keep its assistant/tool
	// tail, and throw away the tagged user prompt that opened it. The tail is then a
	// stranger's conversation with no marker on it at all.
	it("drops a manager turn whose tagged prompt was cut away", () => {
		const messages: Msg[] = [
			managerToolUse(), // ← the compaction cut here
			managerToolResult(),
			user("owner returns"),
			assistantText("welcome back"),
		];
		expect(stripTelegramTurns(messages)).toEqual([
			user("owner returns"),
			assistantText("welcome back"),
		]);
	});

	it("keeps the owner's own turn when the cut lands inside THAT one", () => {
		// The same cut, on a coding turn: nothing here is the manager's, so nothing goes.
		const messages: Msg[] = [
			codingToolUse(),
			codingToolResult(),
			assistantText("done"),
			user("thanks"),
		];
		expect(stripTelegramTurns(messages)).toEqual(messages);
	});

	it("stops looking for the manager's tools at the first real user message", () => {
		// A manager turn LATER in the transcript says nothing about the leading block.
		const messages: Msg[] = [
			assistantText("…mid-answer to the owner…"),
			user("go on"),
			tgUser("a stranger wrote"),
			managerToolUse(),
			managerToolResult(),
		];
		expect(stripTelegramTurns(messages)).toEqual([
			assistantText("…mid-answer to the owner…"),
			user("go on"),
		]);
	});
});

describe("stripTelegramTurnsFromCompaction", () => {
	it("keeps strangers' messages out of the owner's summary", () => {
		// `pi.on("context")` does not run for a compaction — Pi summarises the RAW
		// session. In mixed mode that session holds both threads, so without this the
		// owner's summary is written from other people's private messages, and handed
		// back to the coding thread as its memory of what happened.
		const preparation = {
			messagesToSummarize: [
				user("refactor the parser"),
				assistantText("on it"),
				tgUser("Interlocutor (Bob): what is your address?"),
				managerToolUse(),
				managerToolResult(),
				user("now run the tests"),
			] as Msg[],
			turnPrefixMessages: [
				tgUser("Interlocutor (Alice): are you free tonight?"),
				managerToolUse(),
			] as Msg[],
		};

		const { removed } = stripTelegramTurnsFromCompaction(preparation);

		expect(removed).toBe(5);
		expect(preparation.messagesToSummarize).toEqual([
			user("refactor the parser"),
			assistantText("on it"),
			user("now run the tests"),
		]);
		expect(preparation.turnPrefixMessages).toEqual([]);
		// Not a word of either conversation survives into what gets summarised.
		const text = JSON.stringify(preparation);
		expect(text).not.toContain("address");
		expect(text).not.toContain("tonight");
	});

	it("rewrites the arrays in place — Pi reads the object we were handed", () => {
		const preparation = {
			messagesToSummarize: [user("a")] as Msg[],
			turnPrefixMessages: [] as Msg[],
		};
		const { removed } = stripTelegramTurnsFromCompaction(preparation);
		expect(removed).toBe(0);
		expect(preparation.messagesToSummarize).toEqual([user("a")]);
	});
});
