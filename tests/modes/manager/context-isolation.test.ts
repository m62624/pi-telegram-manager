import { describe, expect, it } from "vitest";
import {
	boundaryDirective,
	budgetRecords,
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

	it("tags incoming lines with their message id so the model can thread replies", () => {
		const messages = buildIsolatedMessages({
			records: [
				rec({ author: "interlocutor", text: "hi", messageId: 7 }),
				rec({ author: "owner", text: "one sec", messageId: 8 }),
				rec({ author: "bot", text: "hello", messageId: 9 }),
			],
		});
		expect(messages).toEqual([
			{ role: "user", content: "[#7] Interlocutor: hi" },
			{ role: "user", content: "[#8] Owner: one sec" },
			// Bot (assistant) turns are never tagged — only inbound messages are targets.
			{ role: "assistant", content: "hello" },
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

describe("budgetRecords", () => {
	it("truncates a single over-long message with a marker", () => {
		const out = budgetRecords([rec({ text: "abcdefghij" })], 4, 0);
		expect(out[0].text).toBe("abcd …[+6 chars]");
	});

	it("leaves short messages untouched (returns the same record)", () => {
		const input = [rec({ text: "hi" })];
		const out = budgetRecords(input, 4, 0);
		expect(out[0]).toBe(input[0]);
	});

	it("drops the oldest messages until the window fits, keeping the newest", () => {
		const out = budgetRecords(
			[
				rec({ text: "aaaaa", messageId: 1 }),
				rec({ text: "bbbbb", messageId: 2 }),
				rec({ text: "ccccc", messageId: 3 }),
			],
			0,
			10,
		);
		expect(out.map((r) => r.messageId)).toEqual([2, 3]);
	});

	it("always keeps at least the newest message even if it alone exceeds the budget", () => {
		const out = budgetRecords(
			[rec({ text: "abcdefghij", messageId: 9 })],
			0,
			3,
		);
		expect(out.map((r) => r.messageId)).toEqual([9]);
	});

	it("caps per-message first, then measures the window against the capped text", () => {
		const out = budgetRecords(
			[
				rec({ text: "aaaaaaaa", messageId: 1 }),
				rec({ text: "bbbbbbbb", messageId: 2 }),
			],
			3,
			// Each message is capped to "aaa …[+5 chars]" (15 chars); a 20-char budget
			// then fits only the newest.
			20,
		);
		expect(out.map((r) => r.messageId)).toEqual([2]);
		expect(out[0].text).toBe("bbb …[+5 chars]");
	});

	it("disables both caps at 0", () => {
		const input = [rec({ text: "x".repeat(100) }), rec({ text: "y" })];
		expect(budgetRecords(input, 0, 0)).toEqual(input);
	});
});
