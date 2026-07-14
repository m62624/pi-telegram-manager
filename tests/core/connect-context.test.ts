import { describe, expect, it } from "vitest";
import {
	systemBlockMessage,
	withSystemBlock,
} from "../../src/core/connect-context";
import { SYSTEM_INSTRUCTIONS_HEADER } from "../../src/instructions/builtin";

/** A session message, structurally as the SDK hands it to `pi.on("context")`. */
const user = (content: string, timestamp = 100) => ({
	role: "user" as const,
	content,
	timestamp,
});
const assistant = (content: string, timestamp = 200) => ({
	role: "assistant" as const,
	content,
	timestamp,
});
const toolResult = (content: string, timestamp = 300) => ({
	role: "toolResult" as const,
	content,
	timestamp,
});

describe("withSystemBlock", () => {
	it("puts the bridge's instructions in front of the conversation", () => {
		const context = withSystemBlock([user("hi")], "You are on Telegram.");
		expect(context).toHaveLength(2);
		expect(context[0]).toEqual({
			role: "user",
			content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\nYou are on Telegram.`,
			timestamp: 0,
		});
		expect(context[1]).toEqual(user("hi"));
	});

	it("APPENDS NOTHING — the last message stays the last message", () => {
		// The bug this module exists for. `pi.on("context")` fires before every call to
		// the model, tool-loop steps included, so anything appended here is appended
		// again on every step — and a trailing `user` message is a TURN. The model read
		// the clock we appended as somebody speaking to it and answered it out loud
		// ("a background tick, I am not replying"), eleven times in one session, into
		// the history and into the chat. Whatever the session ended with must still be
		// what the model reads last.
		const messages = [
			user("read every file in src/"),
			assistant("reading…"),
			toolResult("… 200 lines of code …"),
		];
		const context = withSystemBlock(messages, "You are on Telegram.");
		expect(context).toHaveLength(messages.length + 1);
		expect(context.at(-1)).toEqual(toolResult("… 200 lines of code …"));
		// Not one message of ours anywhere but the head.
		expect(context.slice(1)).toEqual(messages);
	});

	it("is byte-identical across calls, so the prompt cache holds", () => {
		// The block is rebuilt before every call to the model. If any part of it moved
		// — a clock, a counter — the cached prefix would die and the whole session
		// would re-prefill on every step.
		const first = withSystemBlock([user("hi")], "You are on Telegram.");
		const second = withSystemBlock([user("hi")], "You are on Telegram.");
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("leaves the context untouched when the bridge has no instructions", () => {
		expect(withSystemBlock([user("hi")], null)).toEqual([user("hi")]);
		expect(withSystemBlock([user("hi")], "   ")).toEqual([user("hi")]);
	});

	it("copies rather than mutates the array it is given", () => {
		const messages = [user("hi")];
		withSystemBlock(messages, "block");
		expect(messages).toHaveLength(1);
	});

	it("timestamps the block at 0 so it is never sorted into the conversation", () => {
		expect(systemBlockMessage("x").timestamp).toBe(0);
	});
});
