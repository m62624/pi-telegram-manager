import { describe, expect, it } from "vitest";
import { createChatState } from "../../src/storage/chat-state";
import { createContactStore } from "../../src/storage/contact-store";
import { createDmState } from "../../src/storage/dm-state";
import { readJsonIfExists } from "../../src/storage/json";
import { LAYOUT_VERSION, migrateStorage } from "../../src/storage/migrations";
import { createTelegramPaths } from "../../src/storage/paths";
import type { TopicsState } from "../../src/telegram/topics";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

function setup() {
	const fs = new FakeFs();
	return {
		fs,
		run: () => migrateStorage(fs, paths, createContactStore(fs, paths)),
	};
}

async function write(fs: FakeFs, path: string, value: unknown): Promise<void> {
	await fs.writeText(path, JSON.stringify(value, null, 2));
}

/** The whole of an old install, as it really looked on disk. */
async function oldLayout(fs: FakeFs): Promise<void> {
	await write(fs, paths.settingsPath, {
		botToken: "env:TG_TOKEN",
		allowedUserId: 7,
		manager: { debugFeed: false, ownerName: "Alex" },
		topics: { chatName: "me", logName: "bot" },
	});
	await write(fs, paths.legacy.sentRegistryPath, { "42": [1, 2], "43": [9] });
	await write(fs, paths.legacy.consolidationQueuePath, {
		entries: [{ chatId: "42", userId: "5", activityAt: 1000 }],
	});
	await write(fs, paths.legacy.chatCursorsPath, {
		cursors: [{ chatId: "42", handledThrough: 500 }],
	});
	await write(fs, paths.legacy.topicsPath, {
		ownerChatId: 7,
		chat: 11,
		log: 12,
	});
	await write(fs, paths.legacy.modePinPath, { ownerChatId: 7, messageId: 99 });
	await write(fs, paths.legacy.memoryVersionPath, { version: 3 });
}

describe("migrateStorage: a clean install", () => {
	it("writes the marker and touches nothing else", async () => {
		// Nothing here has ever been written. Every step must find its sources absent, do
		// nothing, and say nothing — a first run is not an "upgrade" and must not be
		// announced as one.
		const { fs, run } = setup();
		const outcome = await run();

		expect(outcome).toEqual({
			from: 0,
			to: LAYOUT_VERSION,
			applied: [],
			factsCleared: 0,
		});
		expect(await fs.exists(paths.chatStatePath)).toBe(false);
		expect(await fs.exists(paths.dmStatePath)).toBe(false);
		expect(await fs.exists(paths.legacy.settingsBackupPath)).toBe(false);
		expect(
			await readJsonIfExists<{ version: number }>(fs, paths.schemaVersionPath),
		).toEqual({ version: LAYOUT_VERSION });
	});

	it("leaves a hand-written settings.json exactly as the owner wrote it", async () => {
		const { fs, run } = setup();
		const written = { botToken: "env:TG_TOKEN", allowedUserId: 7 };
		await write(fs, paths.settingsPath, written);
		await run();
		expect(
			await readJsonIfExists<typeof written>(fs, paths.settingsPath),
		).toEqual(written);
	});
});

describe("migrateStorage: an install from before the runner", () => {
	it("carries every chat's bookkeeping into one file, and removes the three", async () => {
		const { fs, run } = setup();
		await oldLayout(fs);
		const outcome = await run();

		expect(outcome.from).toBe(0);
		expect(outcome.applied).toContain("chat-state");

		const state = createChatState(fs, paths.chatStatePath);
		expect(await state.sentRegistry.wasSentByBot("42", 2)).toBe(true);
		expect(await state.sentRegistry.wasSentByBot("43", 9)).toBe(true);
		expect(await state.consolidationQueue.all()).toEqual([
			{ chatId: "42", userId: "5", activityAt: 1000 },
		]);
		expect((await state.cursors.get("42"))?.handledThrough).toBe(500);

		for (const gone of [
			paths.legacy.sentRegistryPath,
			paths.legacy.consolidationQueuePath,
			paths.legacy.chatCursorsPath,
		]) {
			expect(await fs.exists(gone)).toBe(false);
		}
	});

	it("adopts the owner's real forum threads, whatever they were called on disk", async () => {
		// `chat`/`log` were renamed to `personal`/`manager`. The threads are real topics in
		// the owner's DM with their whole history in them: adopting the IDS is the entire
		// point, because creating new ones would orphan every message ever filed there.
		const { fs, run } = setup();
		await oldLayout(fs);
		await run();

		const dm = createDmState<TopicsState>(fs, paths.dmStatePath);
		expect(await dm.loadTopics()).toEqual({
			ownerChatId: 7,
			personal: 11,
			manager: 12,
		});
		// And the pin that stored a single id now stores the list that replaced it.
		expect(await dm.loadModePin()).toEqual({
			ownerChatId: 7,
			messageIds: [99],
		});
		expect(await fs.exists(paths.legacy.topicsPath)).toBe(false);
		expect(await fs.exists(paths.legacy.modePinPath)).toBe(false);
	});

	it("renames the settings keys in the owner's own file, and keeps a copy of the old one", async () => {
		const { fs, run } = setup();
		await oldLayout(fs);
		await run();

		const settings = await readJsonIfExists<{
			botToken: string;
			manager: Record<string, unknown>;
			topics: Record<string, unknown>;
		}>(fs, paths.settingsPath);
		expect(settings?.manager).toEqual({ log: false, ownerName: "Alex" });
		expect(settings?.topics).toEqual({
			personalName: "me",
			managerName: "bot",
		});
		// Everything we did not rename is written back exactly as it was found — including
		// the token reference, which is the one value we must never mangle.
		expect(settings?.botToken).toBe("env:TG_TOKEN");
		// The one file the owner wrote by hand, and the only thing here we rewrite.
		expect(await fs.exists(paths.legacy.settingsBackupPath)).toBe(true);
	});

	it("keeps the value the owner actually set when both spellings are present", async () => {
		const { fs, run } = setup();
		await write(fs, paths.settingsPath, {
			manager: { debugFeed: false, log: true },
		});
		await run();
		expect(
			await readJsonIfExists<{ manager: Record<string, unknown> }>(
				fs,
				paths.settingsPath,
			),
		).toEqual({ manager: { log: true } });
	});

	it("discards contact facts the old rules captured, and says how many", async () => {
		// A fact is a claim about a person. A claim captured under rules we no longer trust
		// is worse than no claim — consolidation re-derives it from a clean transcript.
		const { fs, run } = setup();
		const contacts = createContactStore(fs, paths);
		await contacts.upsertProfile({ userId: "5", displayName: "Alice" }, 0);
		await contacts.addFact("5", { text: "Works at a bank", timestamp: 1 });
		// An install that predates the fact-schema marker entirely.
		await write(fs, paths.legacy.sentRegistryPath, {});

		const outcome = await run();
		expect(outcome.factsCleared).toBe(1);
		expect(await contacts.getFacts("5")).toEqual([]);
		// The profile is not a claim and is kept.
		expect((await contacts.get("5"))?.profile.displayName).toBe("Alice");
	});

	it("does not re-clear facts an earlier memory migration already cleared", async () => {
		const { fs, run } = setup();
		const contacts = createContactStore(fs, paths);
		await contacts.upsertProfile({ userId: "5", displayName: "Alice" }, 0);
		await contacts.addFact("5", { text: "Prefers voice notes", timestamp: 1 });
		await write(fs, paths.legacy.memoryVersionPath, { version: 3 });

		const outcome = await run();
		expect(outcome.factsCleared).toBe(0);
		expect(await contacts.getFacts("5")).toHaveLength(1);
		// Its marker is gone: one number, one file.
		expect(await fs.exists(paths.legacy.memoryVersionPath)).toBe(false);
	});
});

describe("migrateStorage: the things that go wrong", () => {
	it("does nothing at all on a second run", async () => {
		const { fs, run } = setup();
		await oldLayout(fs);
		await run();
		const before = await fs.readText(paths.chatStatePath);

		const second = await run();
		expect(second.applied).toEqual([]);
		expect(second.from).toBe(LAYOUT_VERSION);
		expect(await fs.readText(paths.chatStatePath)).toBe(before);
	});

	it("finishes a run that was killed after the write but before the deletes", async () => {
		// The order is write-then-delete, so this window is real and must be survivable.
		// The next start finds the sources still there, merges them into what is already
		// written, and does not lose the half that made it.
		const { fs, run } = setup();
		await write(fs, paths.legacy.sentRegistryPath, { "42": [1] });
		await write(fs, paths.chatStatePath, {
			chats: [{ chatId: "42", sent: [1], handledThrough: 500 }],
		});

		await run();
		const state = createChatState(fs, paths.chatStatePath);
		expect(await state.all()).toEqual([
			{ chatId: "42", sent: [1], handledThrough: 500 },
		]);
	});

	it("migrates the parts that exist and shrugs at the parts that do not", async () => {
		// A half-used install: the owner ran the manager but never turned topics on, so
		// there is a queue and no threads. Every step is on its own.
		const { fs, run } = setup();
		await write(fs, paths.legacy.consolidationQueuePath, {
			entries: [{ chatId: "42", activityAt: 1 }],
		});

		const outcome = await run();
		expect(outcome.applied).toEqual(["chat-state"]);
		expect(await fs.exists(paths.dmStatePath)).toBe(false);
		expect(
			await createChatState(fs, paths.chatStatePath).consolidationQueue.all(),
		).toHaveLength(1);
	});

	it("leaves a settings file it cannot understand alone", async () => {
		// A broken settings.json is the loader's business to complain about — it can say
		// something useful. What this must NOT do is rewrite it, or take the bot down.
		const { fs, run } = setup();
		await fs.writeText(paths.settingsPath, "{ not json at all");
		const outcome = await run();
		expect(outcome.applied).not.toContain("settings");
		expect(await fs.readText(paths.settingsPath)).toBe("{ not json at all");
	});
});

describe("migrateStorage: a legacy file is never the newer truth", () => {
	it("does not let a stale legacy file overwrite state the bot has since written", async () => {
		// The path that matters: someone removes `schema-version.json` by hand, or downgrades
		// and upgrades again, and the old files are still lying there. The file the bot has
		// been WRITING is the truth; the legacy one is a fossil. Additive merges (`sent`, and
		// the cursors, which take the max) are safe by construction — the queue entry, the
		// topic ids and the pin are not, so they are guarded.
		const { fs, run } = setup();
		await write(fs, paths.chatStatePath, {
			chats: [
				{
					chatId: "42",
					sent: [9],
					consolidation: { userId: "5", activityAt: 9000 },
					handledThrough: 9000,
				},
			],
		});
		await write(fs, paths.dmStatePath, {
			topics: { ownerChatId: 7, personal: 500, manager: 501 },
			modePin: { ownerChatId: 7, messageIds: [500] },
		});
		// …and the fossils, all pointing at an older world.
		await write(fs, paths.legacy.sentRegistryPath, { "42": [1] });
		await write(fs, paths.legacy.consolidationQueuePath, {
			entries: [{ chatId: "42", userId: "OLD", activityAt: 1 }],
		});
		await write(fs, paths.legacy.chatCursorsPath, {
			cursors: [{ chatId: "42", handledThrough: 1 }],
		});
		await write(fs, paths.legacy.topicsPath, {
			ownerChatId: 7,
			chat: 11,
			log: 12,
		});
		await write(fs, paths.legacy.modePinPath, {
			ownerChatId: 7,
			messageId: 99,
		});

		await run();

		const state = createChatState(fs, paths.chatStatePath);
		expect(await state.all()).toEqual([
			{
				chatId: "42",
				// The union — an id we sent is an id we sent, whichever file remembered it.
				sent: [9, 1],
				// NOT the fossil's userId, and NOT its activity stamp.
				consolidation: { userId: "5", activityAt: 9000 },
				// The max: a cursor never moves backwards, and that is exactly what this is.
				handledThrough: 9000,
			},
		]);

		const dm = createDmState<TopicsState>(fs, paths.dmStatePath);
		expect(await dm.loadTopics()).toEqual({
			ownerChatId: 7,
			personal: 500,
			manager: 501,
		});
		expect(await dm.loadModePin()).toEqual({
			ownerChatId: 7,
			messageIds: [500],
		});
	});

	it("keeps a merged id list inside the bound the store keeps", async () => {
		// The merge must not be the one way a chat's id list grows past the cap everything
		// else respects.
		const { fs, run } = setup();
		await write(fs, paths.legacy.sentRegistryPath, {
			"42": Array.from({ length: 260 }, (_, i) => i),
		});
		await run();
		const record = (await createChatState(fs, paths.chatStatePath).all())[0];
		expect(record.sent).toHaveLength(200);
		// The NEWEST are the ones that matter: they are what an inbound update is checked
		// against, and an id from 260 messages ago is never coming back.
		expect(record.sent?.at(-1)).toBe(259);
	});
});
