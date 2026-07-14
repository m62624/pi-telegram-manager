import { describe, expect, it } from "vitest";
import {
	boundaryDirective,
	budgetRecords,
	buildIsolatedMessages,
	toRebuiltMessages,
	windowRecords,
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

describe("windowRecords", () => {
	const record = (i: number, text = `message ${i}`): ChatMessageRecord => ({
		at: i,
		author: i % 2 === 0 ? "interlocutor" : "bot",
		text,
	});
	const many = (n: number) => Array.from({ length: n }, (_, i) => record(i));
	const opts = {
		maxMessages: 20,
		maxCharsPerMessage: 0,
		maxContextChars: 0,
		block: 8,
	};

	it("keeps everything while the conversation fits", () => {
		expect(windowRecords(many(20), opts)).toHaveLength(20);
		expect(windowRecords(many(5), opts)[0].at).toBe(0);
	});

	it("does NOT move for every new message — that is the whole point", () => {
		// A last-N window slides by one per message, so the first line the model reads
		// changes every turn, and everything under it has to be read again. This one holds
		// still and lets the conversation grow over it.
		const starts = [21, 22, 23, 24, 25, 26, 27].map(
			(total) => windowRecords(many(total), opts)[0].at,
		);
		expect(new Set(starts).size).toBe(1);
		expect(starts[0]).toBe(0);
	});

	it("moves a whole block when it finally must", () => {
		// It errs upward first (21…27 messages kept, all from the same first line), and
		// only when a whole block has piled up does the window let go of one.
		expect(windowRecords(many(27), opts)[0].at).toBe(0);
		expect(windowRecords(many(28), opts)[0].at).toBe(8);
		expect(windowRecords(many(35), opts)[0].at).toBe(8);
		expect(windowRecords(many(36), opts)[0].at).toBe(16);
	});

	it("never holds fewer messages than configured", () => {
		// The window errs upward: between maxMessages and maxMessages + block - 1. Being
		// asked to remember 20 and remembering 13 would be a memory bug dressed as a
		// performance one.
		for (let total = 20; total <= 60; total += 1) {
			const kept = windowRecords(many(total), opts).length;
			expect(kept).toBeGreaterThanOrEqual(20);
			expect(kept).toBeLessThan(20 + 8);
		}
	});

	it("still obeys the character budget, and drops on the same grid", () => {
		const long = Array.from({ length: 30 }, (_, i) =>
			record(i, "x".repeat(500)),
		);
		const kept = windowRecords(long, { ...opts, maxContextChars: 5_000 });
		expect(kept.length).toBeLessThanOrEqual(10);
		// On the grid: dropping one message at a time would undo the anchoring that the
		// budget is standing on.
		expect((kept[0].at as number) % 8).toBe(0);
	});

	it("keeps the newest message however long it is", () => {
		const huge = [record(0, "x".repeat(50)), record(1, "y".repeat(100_000))];
		const kept = windowRecords(huge, { ...opts, maxContextChars: 1_000 });
		expect(kept).toHaveLength(1);
		expect(kept[0].text?.startsWith("y")).toBe(true);
	});

	it("truncates one over-long message in place, moving nobody", () => {
		const kept = windowRecords([record(0, "z".repeat(100))], {
			...opts,
			maxCharsPerMessage: 10,
		});
		expect(kept[0].text).toBe(`${"z".repeat(10)} …[+90 chars]`);
	});

	it("survives an empty transcript", () => {
		expect(windowRecords([], opts)).toEqual([]);
	});
});
