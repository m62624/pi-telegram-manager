import { describe, expect, it } from "vitest";
import { createChatState } from "../../src/storage/chat-state";
import { createTelegramPaths } from "../../src/storage/paths";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

function setup(maxSentPerChat?: number) {
	const fs = new FakeFs();
	return {
		fs,
		state: createChatState(fs, paths.chatStatePath, { maxSentPerChat }),
	};
}

describe("chat-state: the sent-message view", () => {
	it("records the bot's own ids and tells them from the owner's", async () => {
		const { state } = setup();
		await state.sentRegistry.recordSent("c", 100);
		expect(await state.sentRegistry.wasSentByBot("c", 100)).toBe(true);
		expect(await state.sentRegistry.wasSentByBot("c", 101)).toBe(false);
		// A manual owner message id (never recorded) reads as not-bot, in any chat.
		expect(await state.sentRegistry.wasSentByBot("other", 100)).toBe(false);
	});

	it("bounds retention per chat", async () => {
		const { state } = setup(3);
		for (let i = 0; i < 5; i += 1) await state.sentRegistry.recordSent("c", i);
		expect(await state.sentRegistry.wasSentByBot("c", 0)).toBe(false); // evicted
		expect(await state.sentRegistry.wasSentByBot("c", 4)).toBe(true);
	});
});

describe("chat-state: the consolidation-queue view", () => {
	it("upserts by chat, refreshing activity without duplicating", async () => {
		const { state } = setup();
		await state.consolidationQueue.upsert({
			chatId: "1",
			userId: "u1",
			activityAt: 100,
		});
		await state.consolidationQueue.upsert({
			chatId: "1",
			userId: "u1",
			activityAt: 200,
		});
		const all = await state.consolidationQueue.all();
		expect(all).toHaveLength(1);
		expect(all[0].activityAt).toBe(200);
	});

	it("returns nothing until an entry has been quiet long enough", async () => {
		const { state } = setup();
		await state.consolidationQueue.upsert({ chatId: "1", activityAt: 1000 });
		expect(await state.consolidationQueue.eligible(1500, 1000)).toBeNull();
		expect((await state.consolidationQueue.eligible(2500, 1000))?.chatId).toBe(
			"1",
		);
	});

	it("returns the oldest-activity eligible entry first", async () => {
		const { state } = setup();
		await state.consolidationQueue.upsert({ chatId: "new", activityAt: 900 });
		await state.consolidationQueue.upsert({ chatId: "old", activityAt: 100 });
		expect((await state.consolidationQueue.eligible(5000, 1000))?.chatId).toBe(
			"old",
		);
	});

	it("removes an entry and survives a reload from disk", async () => {
		const { fs, state } = setup();
		await state.consolidationQueue.upsert({ chatId: "1", activityAt: 1 });
		await state.consolidationQueue.upsert({ chatId: "2", activityAt: 2 });
		await state.consolidationQueue.remove("1");
		const reloaded = createChatState(fs, paths.chatStatePath);
		expect(
			(await reloaded.consolidationQueue.all()).map((e) => e.chatId),
		).toEqual(["2"]);
	});

	it("leaving the queue does not erase what else is known about the chat", async () => {
		// The three views share a record now. Dequeuing a chat must drop its QUEUE ENTRY,
		// not the chat — its cursors are how a restart knows the conversation is dealt
		// with, and taking them out with the queue entry would bring the whole
		// re-answer-everything-on-launch bug straight back.
		const { state } = setup();
		await state.cursors.markHandled("1", 500);
		await state.consolidationQueue.upsert({ chatId: "1", activityAt: 1 });
		await state.consolidationQueue.remove("1");
		expect(await state.consolidationQueue.all()).toEqual([]);
		expect((await state.cursors.get("1"))?.handledThrough).toBe(500);
	});
});

describe("chat-state: the cursor view", () => {
	it("knows nothing about a chat it has never seen", async () => {
		expect(await setup().state.cursors.get("42")).toBeNull();
	});

	it("keeps the two marks apart", async () => {
		// Answered and remembered are different questions about the same chat, and a chat
		// is routinely one without the other: the bot replies for days before an idle
		// moment lets it consolidate anything.
		const { state } = setup();
		await state.cursors.markHandled("42", 500);
		await state.cursors.markConsolidated("42", 300);
		expect(await state.cursors.get("42")).toEqual({
			chatId: "42",
			handledThrough: 500,
			consolidatedThrough: 300,
		});
	});

	it("never moves a mark backwards", async () => {
		// "Already handled" cannot become false. A late write with an older timestamp must
		// not re-open work that is finished, or the restart loop these marks exist to end
		// would simply come back.
		const { state } = setup();
		await state.cursors.markHandled("42", 900);
		await state.cursors.markHandled("42", 100);
		expect((await state.cursors.get("42"))?.handledThrough).toBe(900);

		await state.cursors.markConsolidated("42", 900);
		await state.cursors.markConsolidated("42", 100);
		expect((await state.cursors.get("42"))?.consolidatedThrough).toBe(900);
	});

	it("reads every chat's marks in one go, for the catch-up scan", async () => {
		const { state } = setup();
		await state.cursors.markHandled("1", 10);
		await state.cursors.markHandled("2", 20);
		// A chat we have only ever SENT to has no marks and is not one of them.
		await state.sentRegistry.recordSent("3", 7);
		const all = await state.cursors.all();
		expect(all.get("1")?.handledThrough).toBe(10);
		expect(all.get("2")?.handledThrough).toBe(20);
		expect(all.size).toBe(2);
	});
});

describe("chat-state: one file, three writers", () => {
	it("does not lose an update when the views write at the same time", async () => {
		// The reason the merge is safe, and the thing it would be easiest to get wrong.
		// Every view read-modify-writes the WHOLE file, so two writes that overlap would
		// each read the same base and the last one would win — silently dropping the other.
		// One path means one lock (`withFileWriteLock`), so they queue instead. Pi runs the
		// tool calls of one assistant message concurrently, so this is not hypothetical.
		const { state } = setup();
		await Promise.all([
			state.sentRegistry.recordSent("42", 1),
			state.consolidationQueue.upsert({ chatId: "42", activityAt: 7 }),
			state.cursors.markHandled("42", 500),
			state.cursors.markConsolidated("42", 400),
			state.sentRegistry.recordSent("42", 2),
			state.sentRegistry.recordSent("other", 9),
		]);

		expect(await state.all()).toEqual([
			{
				chatId: "42",
				sent: [1, 2],
				consolidation: { activityAt: 7 },
				handledThrough: 500,
				consolidatedThrough: 400,
			},
			{ chatId: "other", sent: [9] },
		]);
	});

	it("survives a reload: every view reads back what the others wrote", async () => {
		const { fs, state } = setup();
		await state.sentRegistry.recordSent("42", 1);
		await state.consolidationQueue.upsert({
			chatId: "42",
			userId: "u",
			activityAt: 7,
		});
		await state.cursors.markHandled("42", 500);

		const reloaded = createChatState(fs, paths.chatStatePath);
		expect(await reloaded.sentRegistry.wasSentByBot("42", 1)).toBe(true);
		expect((await reloaded.consolidationQueue.all())[0].userId).toBe("u");
		expect((await reloaded.cursors.get("42"))?.handledThrough).toBe(500);
	});

	it("forgets a chat entirely when its transcript is gone", async () => {
		const { state } = setup();
		await state.sentRegistry.recordSent("42", 1);
		await state.cursors.markHandled("42", 500);
		await state.cursors.remove("42");
		expect(await state.all()).toEqual([]);
		await expect(state.cursors.remove("nobody")).resolves.toBeUndefined();
	});
});
