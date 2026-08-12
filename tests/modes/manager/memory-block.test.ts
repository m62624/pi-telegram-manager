import { describe, expect, it } from "vitest";
import {
	consolidationMemoryBlock,
	dropVisible,
	memoryBlock,
	recallQuery,
} from "../../../src/modes/manager/memory-block";
import type { ChatMessageRecord } from "../../../src/storage/chat-store";

function said(
	author: ChatMessageRecord["author"],
	text: string,
	over: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
	return { author, text, timestamp: 0, ...over };
}

describe("recallQuery", () => {
	it("asks about the unanswered tail, not the whole window", () => {
		// Everything before the last reply has been dealt with by somebody, and it is in
		// the transcript verbatim — spending the recall budget on it re-fetches what the
		// model can already read.
		expect(
			recallQuery([
				said("interlocutor", "old question"),
				said("bot", "answered"),
				said("interlocutor", "new question"),
			]),
		).toBe("new question");
	});

	it("stops at a message of the owner's, too", () => {
		expect(
			recallQuery([
				said("interlocutor", "earlier"),
				said("owner", "I'll take this"),
				said("interlocutor", "and one more thing"),
			]),
		).toBe("and one more thing");
	});

	it("joins a batch, newest last", () => {
		expect(
			recallQuery([
				said("bot", "hi"),
				said("interlocutor", "one"),
				said("interlocutor", "two"),
			]),
		).toBe("one\ntwo");
	});

	it("is empty when nobody is waiting", () => {
		// A revise turn, or a turn with no unanswered interlocutor batch, has no
		// text query. Owner-summoned contact turns use a separate entity-scoped
		// inventory path in the controller.
		expect(recallQuery([said("interlocutor", "x"), said("bot", "y")])).toBe("");
		expect(recallQuery([])).toBe("");
	});

	it("uses their own words, never what they quoted", () => {
		// A reply that quotes three paragraphs would otherwise make the query about
		// somebody else's text.
		expect(
			recallQuery([
				said("interlocutor", "sounds good", {
					context: "[reply] a long message written by the owner",
				}),
			]),
		).toBe("sounds good");
		// A forward is not their words at all.
		expect(
			recallQuery([
				said("interlocutor", "someone else's post", { forwarded: true }),
			]),
		).toBe("");
	});

	it("caps a pathological paste rather than drowning the query", () => {
		const wall = "word ".repeat(500);
		expect(
			recallQuery([said("interlocutor", wall)]).length,
		).toBeLessThanOrEqual(600);
	});
});

describe("dropVisible", () => {
	const rendered =
		"## memory\n" +
		"- [f0] Alice: I moved to Berlin (2026-08; active) #episode #message\n" +
		"- [f1] Alice: prefers voice notes (2026-07; active) #fact #preference\n";

	it("drops what the transcript above already shows", () => {
		// Every inbound message is stored as an episode, so the batch just received is in
		// the memory within milliseconds of arriving — and a recall about that batch ranks
		// it first. Left alone, the block opens by quoting back the line three rows above
		// it, which costs tokens to say nothing.
		const kept = dropVisible(rendered, [
			said("interlocutor", "I moved to Berlin"),
		]);
		expect(kept).not.toContain("I moved to Berlin");
		expect(kept).toContain("prefers voice notes");
	});

	it("keeps everything when the transcript shows none of it", () => {
		const kept = dropVisible(rendered, [said("interlocutor", "hello")]);
		expect(kept).toContain("I moved to Berlin");
		expect(kept).toContain("prefers voice notes");
	});

	it("returns nothing at all when every line was already visible", () => {
		// A heading with nothing under it says the memory answered and shows nothing.
		const kept = dropVisible(rendered, [
			said("interlocutor", "I moved to Berlin"),
			said("interlocutor", "prefers voice notes"),
		]);
		expect(kept).toBe("");
	});
});

describe("memoryBlock", () => {
	it("says nothing when there is nothing to say", () => {
		// An empty heading is a tax on every turn of every chat with no memory yet, and it
		// teaches a small model that the section is usually noise.
		expect(memoryBlock("", "Alice")).toBe("");
		expect(memoryBlock("   \n  ", "Alice")).toBe("");
	});

	it("tells the model whose memory it is, and that ignoring it is allowed", () => {
		const block = memoryBlock("- [f0] Alice: likes green tea", "Alice");
		expect(block).toContain("What you remember about Alice");
		expect(block).toContain("likes green tea");
		// It is retrieved by relevance and may be off-target — a model that cannot ignore
		// it will answer a question about lunch with a fact about tea.
		expect(block).toContain("ignore it entirely");
		expect(block).toContain("not something they just said");
	});
});

describe("consolidationMemoryBlock", () => {
	it("says plainly when there is nothing stored yet", () => {
		expect(consolidationMemoryBlock("")).toContain("empty");
	});

	it("tells the pass that the ids are actionable", () => {
		const block = consolidationMemoryBlock("- [f3] Alice: works at a bank");
		expect(block).toContain("[fN]");
		expect(block).toContain("telegram_manager_revise");
		expect(block).toContain("telegram_manager_forget");
	});
});
