import { describe, expect, it } from "vitest";
import {
	isTelegramTurn,
	MIXED_TELEGRAM_MARKER,
	stripTelegramTurns,
	tagTelegramPrompt,
} from "../../../src/modes/manager/mixed-context";

type Msg = {
	role: string;
	content: string | { type?: string; text?: string }[];
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
