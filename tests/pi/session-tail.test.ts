import { describe, expect, it } from "vitest";
import { MIXED_TELEGRAM_MARKER } from "../../src/modes/manager/mixed-context";
import {
	extractSessionTail,
	TAIL_MESSAGE_MAX_LEN,
	type TailSourceMessage,
} from "../../src/pi/session-tail";

/** A user message with plain string content. */
function user(text: string): TailSourceMessage {
	return { role: "user", content: text };
}

/** An assistant message with block content. */
function assistant(text: string): TailSourceMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("extractSessionTail", () => {
	it("keeps only the last N user/assistant messages, oldest-first", () => {
		const messages = [
			user("one"),
			assistant("two"),
			user("three"),
			assistant("four"),
		];
		expect(extractSessionTail(messages, 2)).toEqual([
			{ role: "user", text: "three", images: [] },
			{ role: "assistant", text: "four", images: [] },
		]);
	});

	it("returns everything when fewer than the cap", () => {
		const messages = [user("hi"), assistant("hello")];
		expect(extractSessionTail(messages, 10)).toEqual([
			{ role: "user", text: "hi", images: [] },
			{ role: "assistant", text: "hello", images: [] },
		]);
	});

	it("drops tool results and toolCall-only assistant messages", () => {
		const messages: TailSourceMessage[] = [
			user("do a thing"),
			{ role: "assistant", content: [{ type: "toolCall" }] },
			{ role: "toolResult", content: [{ type: "text", text: "result blob" }] },
			assistant("done"),
		];
		expect(extractSessionTail(messages, 10)).toEqual([
			{ role: "user", text: "do a thing", images: [] },
			{ role: "assistant", text: "done", images: [] },
		]);
	});

	it("drops empty and whitespace-only messages", () => {
		const messages = [user("   "), assistant(""), user("real")];
		expect(extractSessionTail(messages, 10)).toEqual([
			{ role: "user", text: "real", images: [] },
		]);
	});

	it("strips the hidden Telegram-turn marker and collapses whitespace", () => {
		const messages = [user(`${MIXED_TELEGRAM_MARKER}hello   there\n\nagain`)];
		expect(extractSessionTail(messages, 10)).toEqual([
			{ role: "user", text: "hello there again", images: [] },
		]);
	});

	it("extracts images verbatim, and keeps a photo-only message as a card", () => {
		const messages: TailSourceMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "AAA", mimeType: "image/png" },
				],
			},
			// A photo with no words still becomes a card (so a reply can point at it).
			{
				role: "user",
				content: [{ type: "image", data: "BBB", mimeType: "image/jpeg" }],
			},
		];
		expect(extractSessionTail(messages, 10)).toEqual([
			{
				role: "user",
				text: "look",
				images: [{ data: "AAA", mimeType: "image/png" }],
			},
			{
				role: "user",
				text: "[photo]",
				images: [{ data: "BBB", mimeType: "image/jpeg" }],
			},
		]);
	});

	it("truncates an over-long message with an ellipsis", () => {
		const long = "x".repeat(TAIL_MESSAGE_MAX_LEN + 50);
		const [only] = extractSessionTail([user(long)], 10);
		expect(only?.text).toHaveLength(TAIL_MESSAGE_MAX_LEN);
		expect(only?.text.endsWith("…")).toBe(true);
	});

	it("returns nothing for a session with no readable conversation", () => {
		const messages: TailSourceMessage[] = [
			{ role: "toolResult", content: "blob" },
			{ role: "assistant", content: [{ type: "toolCall" }] },
		];
		expect(extractSessionTail(messages, 10)).toEqual([]);
	});

	it("treats a non-positive cap as empty", () => {
		expect(extractSessionTail([user("a")], 0)).toEqual([]);
	});
});
