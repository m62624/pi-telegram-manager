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
		await state.forget("42");
		expect(await state.all()).toEqual([]);
		await expect(state.forget("nobody")).resolves.toBeUndefined();
	});
});

/**
 * The invariants of one file with several writers, stated one at a time.
 *
 * Three views share a record, every write is a read-modify-write of the WHOLE file, and
 * the events that drive them (a message out, a message in, a turn settling, a memory pass
 * finishing) genuinely overlap. This is where a merge like this gets people's data lost,
 * so it is worth spelling out what may never happen.
 */
describe("chat-state: what may never happen", () => {
	it("a writer never touches a field it does not own", async () => {
		// Every field of one chat, written by a different view, all at once. If any writer
		// carried a stale copy of the record back to disk, one of these would be missing —
		// which is exactly how a merged file eats an update.
		const { state } = setup();
		await state.sentRegistry.recordSent("42", 1);
		await state.consolidationQueue.upsert({
			chatId: "42",
			userId: "u",
			activityAt: 100,
		});
		await state.cursors.markHandled("42", 500);
		await state.cursors.markConsolidated("42", 400);

		await Promise.all([
			state.sentRegistry.recordSent("42", 2),
			state.consolidationQueue.upsert({
				chatId: "42",
				userId: "u",
				activityAt: 200,
			}),
			state.cursors.markHandled("42", 600),
			state.cursors.markConsolidated("42", 450),
		]);

		expect(await state.all()).toEqual([
			{
				chatId: "42",
				sent: [1, 2],
				consolidation: { userId: "u", activityAt: 200 },
				handledThrough: 600,
				consolidatedThrough: 450,
			},
		]);
	});

	it("does not lose a write to one chat under a storm of writes to others", async () => {
		// Different chats are different records in the same file, so "it is a different
		// chat" is not the same as "it is a different file" any more. Twelve chats, four
		// writers each, all interleaved: nothing may be dropped.
		const { state } = setup();
		const chats = Array.from({ length: 12 }, (_, i) => `chat-${i}`);
		await Promise.all(
			chats.flatMap((chatId, i) => [
				state.sentRegistry.recordSent(chatId, i),
				state.sentRegistry.recordSent(chatId, i + 100),
				state.consolidationQueue.upsert({ chatId, activityAt: i }),
				state.cursors.markHandled(chatId, i * 10),
			]),
		);

		const all = await state.all();
		expect(all).toHaveLength(12);
		for (const [i, chatId] of chats.entries()) {
			const record = all.find((chat) => chat.chatId === chatId);
			expect(record?.sent).toEqual([i, i + 100]);
			expect(record?.consolidation?.activityAt).toBe(i);
			expect(record?.handledThrough).toBe(i * 10);
		}
	});

	it("a cursor cannot go backwards, however the writes are ordered", async () => {
		// A late write with an older stamp is not news, it is an echo — and honouring it
		// would re-open a conversation that is finished, which is the bug the cursors exist
		// to close. Fired all at once, the newest must win regardless of who lands last.
		const { state } = setup();
		await Promise.all([
			state.cursors.markHandled("42", 300),
			state.cursors.markHandled("42", 900),
			state.cursors.markHandled("42", 100),
			state.cursors.markConsolidated("42", 50),
			state.cursors.markConsolidated("42", 800),
			state.cursors.markConsolidated("42", 200),
		]);
		expect(await state.cursors.get("42")).toEqual({
			chatId: "42",
			handledThrough: 900,
			consolidatedThrough: 800,
		});
	});

	it("a cursor that refuses to move does not leave a ghost behind", async () => {
		// The refusal is a legitimate no-op, and it used to write an empty `{ chatId }`
		// record for a chat nothing is known about — a file that grows a line every time it
		// is asked a question and answers no.
		const { state } = setup();
		await state.cursors.markHandled("42", 100);
		await state.cursors.markHandled("42", 50); // an echo: ignored
		await state.cursors.markHandled("never-seen", Number.NaN); // not a time at all
		expect((await state.all()).map((chat) => chat.chatId)).toEqual(["42"]);
	});

	it("leaving the queue while a turn settles keeps both outcomes", async () => {
		// The memory pass finishes (dequeue) exactly as the live turn settles (a cursor).
		// They are one record now, and both must survive — dropping the cursor here is the
		// answer-everything-again-on-launch bug, and dropping the dequeue is a memory pass
		// that runs forever.
		const { state } = setup();
		await state.consolidationQueue.upsert({ chatId: "42", activityAt: 1 });
		await Promise.all([
			state.consolidationQueue.remove("42"),
			state.cursors.markConsolidated("42", 700),
			state.cursors.markHandled("42", 800),
			state.sentRegistry.recordSent("42", 5),
		]);
		expect(await state.all()).toEqual([
			{
				chatId: "42",
				sent: [5],
				handledThrough: 800,
				consolidatedThrough: 700,
			},
		]);
	});

	it("a chat that leaves the queue with nothing else to its name leaves the file", async () => {
		const { state } = setup();
		await state.consolidationQueue.upsert({ chatId: "42", activityAt: 1 });
		await state.consolidationQueue.remove("42");
		expect(await state.all()).toEqual([]);
	});

	it("forgetting a chat under load forgets that chat and no other", async () => {
		const { state } = setup();
		await state.sentRegistry.recordSent("keep", 1);
		await state.cursors.markHandled("drop", 5);
		await Promise.all([
			state.forget("drop"),
			state.sentRegistry.recordSent("keep", 2),
			state.cursors.markHandled("keep", 9),
		]);
		expect(await state.all()).toEqual([
			{ chatId: "keep", sent: [1, 2], handledThrough: 9 },
		]);
	});

	it("holds up under a hundred overlapping writes", async () => {
		// The real shape of a busy minute: several chats, every view firing, nothing awaited
		// in order. Every single write must be in the file at the end of it.
		const { state } = setup();
		const writes: Promise<unknown>[] = [];
		for (let i = 0; i < 25; i += 1) {
			const chatId = `chat-${i % 5}`;
			writes.push(state.sentRegistry.recordSent(chatId, i));
			writes.push(state.consolidationQueue.upsert({ chatId, activityAt: i }));
			writes.push(state.cursors.markHandled(chatId, i));
			writes.push(state.cursors.markConsolidated(chatId, i));
		}
		await Promise.all(writes);

		const all = await state.all();
		expect(all).toHaveLength(5);
		for (const record of all) {
			const index = Number(record.chatId.split("-")[1]);
			// Five writes per chat, ids index, index+5, … index+20 — all of them present.
			expect(record.sent).toEqual([
				index,
				index + 5,
				index + 10,
				index + 15,
				index + 20,
			]);
			// The newest stamp wins for the queue, and the highest for each cursor.
			expect(record.consolidation?.activityAt).toBe(index + 20);
			expect(record.handledThrough).toBe(index + 20);
			expect(record.consolidatedThrough).toBe(index + 20);
		}
	});
});
