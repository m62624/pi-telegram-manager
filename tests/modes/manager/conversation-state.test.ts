import { describe, expect, it } from "vitest";
import {
	analyzeChat,
	conversationStateCard,
} from "../../../src/modes/manager/conversation-state";
import type {
	ChatAuthor,
	ChatMessageRecord,
} from "../../../src/storage/chat-store";

const rec = (
	author: ChatAuthor,
	timestamp: number,
	text = "x",
	messageId?: number,
): ChatMessageRecord => ({ author, text, timestamp, messageId });

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

describe("conversationStateCard", () => {
	it("summarises the unanswered batch without changing the reply decision", () => {
		const card = conversationStateCard([
			rec("bot", 1, "Here is the plan", 10),
			rec("interlocutor", 2, "what are you doing", 11),
		]);

		expect(card).toContain("State: batch #11; last=interlocutor; addr=no");
		// The card gives examples, but does not classify a language by string matching.
		expect(card).toContain("Meaning: question/request/thread -> reply");
		expect(card).toContain("Personal asks count");
	});

	it("keeps acknowledgement and closure examples near the decision", () => {
		const card = conversationStateCard([
			rec("interlocutor", 1, "Sounds good!", 7),
		]);

		expect(card).toContain("ok/thanks/closure/chatter -> silent");
	});

	it("does not turn a direct-address signal into an unconditional reply", () => {
		const card = conversationStateCard(
			[rec("interlocutor", 1, "Manager, okay", 7)],
			{ directAddressed: true },
		);

		expect(card).toContain("addr=yes");
		expect(card).toContain("mention alone no");
	});
});
