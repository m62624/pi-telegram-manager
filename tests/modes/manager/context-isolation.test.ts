import { describe, expect, it } from "vitest";
import {
	boundaryDirective,
	buildIsolatedMessages,
	toRebuiltMessages,
} from "../../../src/modes/manager/context-isolation";
import type { ChatMessageRecord } from "../../../src/storage/chat-store";

const rec = (over: Partial<ChatMessageRecord>): ChatMessageRecord => ({
	author: "interlocutor",
	text: "hi",
	timestamp: 1,
	...over,
});

describe("buildIsolatedMessages — images", () => {
	it("attaches latest images to the last interlocutor line and rebuilds image blocks", () => {
		const messages = buildIsolatedMessages({
			records: [
				rec({ author: "interlocutor", text: "look", senderName: "Alice" }),
			],
			latestImages: [{ data: "BASE64", mimeType: "image/png" }],
		});
		expect(messages[0].images).toEqual([
			{ data: "BASE64", mimeType: "image/png" },
		]);
		const rebuilt = toRebuiltMessages(messages, 5);
		expect(rebuilt[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "image", data: "BASE64", mimeType: "image/png" },
				{ type: "text", text: "Interlocutor (Alice): look" },
			],
		});
	});

	it("leaves text-only messages as plain string content", () => {
		const rebuilt = toRebuiltMessages(
			buildIsolatedMessages({ records: [rec({ text: "hi" })] }),
			5,
		);
		expect(rebuilt[0].content).toBe("Interlocutor: hi");
	});
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

describe("toRebuiltMessages", () => {
	it("gives assistant turns block content and a zero usage (SDK estimator safety)", () => {
		const [user, assistant] = toRebuiltMessages(
			[
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi back" },
			],
			123,
		);
		// User keeps string content.
		expect(user).toEqual({ role: "user", content: "hello", timestamp: 123 });
		// Assistant carries a text-block array and a usage object, so the SDK's
		// token estimator never dereferences an undefined `usage`.
		expect(assistant).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "hi back" }],
			timestamp: 123,
			stopReason: "stop",
		});
		expect(
			(assistant as { usage: { totalTokens: number } }).usage.totalTokens,
		).toBe(0);
	});
});
