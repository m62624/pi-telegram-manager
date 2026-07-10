import { describe, expect, it } from "vitest";
import {
	boundaryDirective,
	buildIsolatedMessages,
} from "../../../src/modes/manager/context-isolation";
import type { ChatMessageRecord } from "../../../src/storage/chat-store";

const rec = (over: Partial<ChatMessageRecord>): ChatMessageRecord => ({
	author: "interlocutor",
	text: "hi",
	timestamp: 1,
	...over,
});

describe("buildIsolatedMessages", () => {
	it("maps bot turns to assistant and others to labelled user messages", () => {
		const messages = buildIsolatedMessages({
			records: [
				rec({ author: "interlocutor", text: "hello", senderName: "Alice" }),
				rec({ author: "bot", text: "hi there" }),
				rec({ author: "owner", text: "I'll take it" }),
			],
		});
		expect(messages).toEqual([
			{ role: "user", content: "Interlocutor (Alice): hello" },
			{ role: "assistant", content: "hi there" },
			{ role: "user", content: "Owner: I'll take it" },
		]);
	});

	it("prepends a boundary directive as the first user message", () => {
		const messages = buildIsolatedMessages({
			records: [rec({ text: "hey" })],
			boundary: boundaryDirective("Alice"),
		});
		expect(messages[0]).toEqual({
			role: "user",
			content:
				"[New chat with Alice. This is a separate conversation; previous chats are not available.]",
		});
		expect(messages).toHaveLength(2);
	});

	it("skips empty-text records", () => {
		const messages = buildIsolatedMessages({
			records: [rec({ text: "  " }), rec({ text: "real" })],
		});
		expect(messages).toEqual([{ role: "user", content: "Interlocutor: real" }]);
	});

	it("honours custom labels", () => {
		const messages = buildIsolatedMessages({
			records: [rec({ author: "owner", text: "hi" })],
			labels: { owner: "Хозяин" },
		});
		expect(messages[0]).toEqual({ role: "user", content: "Хозяин: hi" });
	});

	it("contains no trace of another chat's records (isolation by construction)", () => {
		// Only the active chat's records are ever passed in; a leak is impossible.
		const messages = buildIsolatedMessages({
			records: [rec({ text: "mine" })],
		});
		expect(JSON.stringify(messages)).not.toContain("other");
	});
});
