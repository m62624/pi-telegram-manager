import { describe, expect, it } from "vitest";
import { selectCatchUpChats } from "../../../src/modes/manager/catchup";
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
