import { describe, expect, it } from "vitest";
import {
	estimateTokens,
	measureContext,
	totalChars,
} from "../../src/core/context-measure";
import { SYSTEM_INSTRUCTIONS_HEADER } from "../../src/instructions/builtin";

const instructions = {
	role: "user",
	content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${"i".repeat(400)}`,
};
const owner = { role: "user", content: "x".repeat(100) };
const reply = {
	role: "assistant",
	content: [{ type: "text", text: "y".repeat(200) }],
};
const toolOutput = {
	role: "toolResult",
	content: [{ type: "text", text: "z".repeat(4000) }],
};

describe("measureContext", () => {
	it("sizes each part of the context separately", () => {
		const snapshot = measureContext(
			"personal",
			[instructions, owner, reply, toolOutput],
			1000,
		);
		expect(snapshot.source).toBe("personal");
		expect(snapshot.takenAt).toBe(1000);
		expect(snapshot.messages).toBe(4);
		expect(snapshot.chars.user).toBe(100);
		expect(snapshot.chars.assistant).toBe(200);
		expect(snapshot.chars.tool).toBe(4000);
		// The header is part of the instructions, so it is counted with them.
		expect(snapshot.chars.instructions).toBe(
			SYSTEM_INSTRUCTIONS_HEADER.length + 2 + 400,
		);
	});

	it("does not count our own instructions as something the owner said", () => {
		// The block goes in as a `user` message (Pi has no system-message role for us),
		// but reporting it as the owner's words would make every context look like a
		// conversation nobody had.
		const snapshot = measureContext("personal", [instructions, owner], 0);
		expect(snapshot.counts.user).toBe(1);
		expect(snapshot.chars.user).toBe(100);
	});

	it("counts tool output, which is what actually fills a context", () => {
		const snapshot = measureContext(
			"personal",
			[owner, reply, toolOutput, toolOutput, toolOutput],
			0,
		);
		expect(snapshot.counts.tool).toBe(3);
		expect(snapshot.chars.tool).toBe(12_000);
		// Nobody typed those 12k characters. That is the point of showing them.
		expect(snapshot.chars.tool / totalChars(snapshot)).toBeGreaterThan(0.9);
	});

	it("counts a tool CALL's arguments — the model wrote them into the prompt too", () => {
		const call = {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "/a/b/c.ts" } },
			],
		};
		expect(measureContext("personal", [call], 0).chars.assistant).toBe(
			JSON.stringify({ path: "/a/b/c.ts" }).length,
		);
	});

	it("counts inline images, whose cost their text never shows", () => {
		const withImage = {
			role: "user",
			content: [
				{ type: "image", data: "…base64…", mimeType: "image/png" },
				{ type: "text", text: "what is this?" },
			],
		};
		const snapshot = measureContext("personal", [withImage], 0);
		expect(snapshot.images).toBe(1);
		expect(snapshot.chars.user).toBe("what is this?".length);
	});

	it("survives a message shape it has never seen", () => {
		const odd = { role: "bashExecution" } as { role: string };
		expect(() => measureContext("personal", [odd], 0)).not.toThrow();
		expect(measureContext("personal", [odd], 0).counts.other).toBe(1);
	});
});

describe("estimateTokens", () => {
	it("uses the same chars/4 rule as Pi's own estimator", () => {
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(0)).toBe(0);
	});
});
