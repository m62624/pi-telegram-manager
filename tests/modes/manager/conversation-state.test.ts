import { describe, expect, it } from "vitest";
import { analyzeChat } from "../../../src/modes/manager/conversation-state";
import type {
	ChatAuthor,
	ChatMessageRecord,
} from "../../../src/storage/chat-store";

const rec = (author: ChatAuthor, timestamp: number): ChatMessageRecord => ({
	author,
	text: "x",
	timestamp,
});

describe("analyzeChat", () => {
	it("reports empty state for an empty transcript", () => {
		const state = analyzeChat([]);
		expect(state.lastAuthor).toBeNull();
		expect(state.lastMessageAt).toBeNull();
		expect(state.interlocutorWaiting).toBe(false);
		expect(state.answered).toBe(true);
		expect(state.botReplies).toBe(0);
	});

	it("flags the interlocutor as waiting when they spoke last", () => {
		const state = analyzeChat([rec("interlocutor", 1)]);
		expect(state.interlocutorWaiting).toBe(true);
		expect(state.answered).toBe(false);
		expect(state.lastInterlocutorAt).toBe(1);
	});

	it("counts the chat as answered when the owner replied after", () => {
		const state = analyzeChat([rec("interlocutor", 1), rec("owner", 2)]);
		expect(state.interlocutorWaiting).toBe(false);
		expect(state.answered).toBe(true);
		expect(state.lastAuthor).toBe("owner");
	});

	it("counts the chat as answered when the bot replied after", () => {
		const state = analyzeChat([rec("interlocutor", 1), rec("bot", 2)]);
		expect(state.answered).toBe(true);
		expect(state.interlocutorWaiting).toBe(false);
	});

	it("counts bot replies for never-replied prioritisation", () => {
		const state = analyzeChat([
			rec("interlocutor", 1),
			rec("bot", 2),
			rec("interlocutor", 3),
			rec("bot", 4),
			rec("interlocutor", 5),
		]);
		expect(state.botReplies).toBe(2);
		expect(state.interlocutorWaiting).toBe(true);
		expect(state.lastMessageAt).toBe(5);
	});
});
