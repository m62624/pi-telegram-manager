import { describe, expect, it } from "vitest";
import {
	lastInterlocutorUserId,
	selectCatchUpChats,
} from "../../../src/modes/manager/catchup";
import type {
	ChatAuthor,
	ChatMessageRecord,
} from "../../../src/storage/chat-store";

const NOW = 100_000_000;
const OPTS = { ownerReplyWindowMs: 300_000, catchUpWindowMs: 36_000_000 };

const rec = (
	author: ChatAuthor,
	timestamp: number,
	text = "hi",
): ChatMessageRecord => ({ author, text, timestamp });

const chat = (chatId: string, records: ChatMessageRecord[]) => ({
	chatId,
	records,
});

describe("selectCatchUpChats", () => {
	it("selects a waiting chat past the owner window and still recent", () => {
		const chats = [chat("1", [rec("interlocutor", NOW - 600_000)])];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual(["1"]);
	});

	it("skips a chat the owner already answered", () => {
		const chats = [
			chat("1", [
				rec("interlocutor", NOW - 600_000),
				rec("owner", NOW - 500_000),
			]),
		];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual([]);
	});

	it("skips a chat still inside the owner-reply window", () => {
		const chats = [chat("1", [rec("interlocutor", NOW - 100_000)])];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual([]);
	});

	it("skips a stale chat beyond the catch-up window", () => {
		const chats = [chat("1", [rec("interlocutor", NOW - 40_000_000)])];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual([]);
	});

	it("skips an empty-text reaction", () => {
		const chats = [chat("1", [rec("interlocutor", NOW - 600_000, "   ")])];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual([]);
	});

	it("orders selected chats oldest-waiting first", () => {
		const chats = [
			chat("newer", [rec("interlocutor", NOW - 400_000)]),
			chat("older", [rec("interlocutor", NOW - 900_000)]),
		];
		expect(selectCatchUpChats(chats, NOW, OPTS)).toEqual(["older", "newer"]);
	});
});

// Who the chat is WITH decides where facts are stored — and a chat that looks like the
// owner talking to themselves is dropped from consolidation entirely. So reading the
// owner's own id back out of a transcript is not a cosmetic slip: it silently costs a
// contact their memory. Seen live: a friend's chat sat in the queue under the owner's
// user id, and that friend accumulated no facts at all.
describe("lastInterlocutorUserId", () => {
	const owner = "1";

	it("reads the interlocutor's id from their own message", () => {
		const records = [
			rec("owner", 1),
			{ ...rec("interlocutor", 2), senderId: "42" },
		];
		expect(lastInterlocutorUserId(records, owner)).toBe("42");
	});

	it("never returns the owner's id, however the transcript files their message", () => {
		// Early transcripts hold the owner's own messages as `interlocutor`: they were
		// stored before the bot learned which Secretary account it speaks for.
		const records = [
			{ ...rec("interlocutor", 1), senderId: "42" },
			{ ...rec("interlocutor", 2), senderId: owner },
		];
		expect(lastInterlocutorUserId(records, owner)).toBe("42");
	});

	it("is undefined when the chat has no interlocutor but the owner", () => {
		const records = [{ ...rec("interlocutor", 1), senderId: owner }];
		expect(lastInterlocutorUserId(records, owner)).toBeUndefined();
	});
});
