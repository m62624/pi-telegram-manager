import { describe, expect, it } from "vitest";
import { conversationOnly } from "../../src/core/compaction-material";

describe("conversationOnly", () => {
	it("drops the tool output and keeps what was said, in order", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "port the parser" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading it" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "toolResult",
				content: [{ type: "text", text: "…50k of file…" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done, it uses regex" }],
			},
		];
		expect(conversationOnly(messages)).toEqual([
			messages[0],
			{ role: "assistant", content: [{ type: "text", text: "reading it" }] },
			messages[3],
		]);
	});

	it("drops an assistant message that was nothing but a tool call", () => {
		// It said nothing. In a summary it is noise with a name attached.
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }],
			},
			{ role: "user", content: [{ type: "text", text: "and now?" }] },
		];
		expect(conversationOnly(messages)).toEqual([messages[1]]);
	});

	it("keeps a plain-string message (the bridge's own system block is one)", () => {
		const messages = [{ role: "user", content: "[SYSTEM_INSTRUCTIONS] …" }];
		expect(conversationOnly(messages)).toEqual(messages);
	});

	it("does not mutate what it is given — Pi's plan must survive the retry", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "on it" },
				{ type: "toolCall", name: "read" },
			],
		};
		const messages = [assistant];
		conversationOnly(messages);
		expect(assistant.content).toHaveLength(2);
		expect(messages).toHaveLength(1);
	});

	it("survives anything that is not a message", () => {
		expect(conversationOnly([null, undefined, 7, "text"])).toEqual([]);
	});
});
