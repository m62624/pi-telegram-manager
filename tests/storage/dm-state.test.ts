import { describe, expect, it } from "vitest";
import { createDmState } from "../../src/storage/dm-state";
import { createTelegramPaths } from "../../src/storage/paths";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

/** Stands in for the topics blob: `storage/` neither knows nor cares what is in it. */
interface Threads {
	ownerChatId: number;
	personal: number;
	manager: number;
}

function setup() {
	const fs = new FakeFs();
	return { fs, dm: createDmState<Threads>(fs, paths.dmStatePath) };
}

describe("dm-state", () => {
	it("starts out knowing nothing", async () => {
		const { dm } = setup();
		expect(await dm.loadTopics()).toBeNull();
		expect(await dm.loadModePin()).toBeNull();
	});

	it("keeps the threads and the pin apart, in one file", async () => {
		const { fs, dm } = setup();
		await dm.saveTopics({ ownerChatId: 1, personal: 10, manager: 20 });
		await dm.saveModePin({ ownerChatId: 1, messageIds: [7] });

		const reloaded = createDmState<Threads>(fs, paths.dmStatePath);
		expect(await reloaded.loadTopics()).toEqual({
			ownerChatId: 1,
			personal: 10,
			manager: 20,
		});
		expect(await reloaded.loadModePin()).toEqual({
			ownerChatId: 1,
			messageIds: [7],
		});
	});

	it("does not lose one when both are written at once", async () => {
		// They share a file now, and both are whole-file read-modify-writes: without a
		// lock on the path, a topic rename and a re-pin landing together would each write
		// a copy missing the other's work. One path, one lock — they queue.
		const { dm } = setup();
		await Promise.all([
			dm.saveTopics({ ownerChatId: 1, personal: 10, manager: 20 }),
			dm.saveModePin({ ownerChatId: 1, messageIds: [7] }),
		]);
		expect(await dm.loadTopics()).not.toBeNull();
		expect(await dm.loadModePin()).not.toBeNull();
	});

	it("forgets the pin without forgetting the threads", async () => {
		// The pin is dropped on an error path (better a new one than a ghost). The topics
		// are threads that exist in Telegram — losing their ids because a pin went wrong
		// would orphan the owner's whole history.
		const { dm } = setup();
		await dm.saveTopics({ ownerChatId: 1, personal: 10, manager: 20 });
		await dm.saveModePin({ ownerChatId: 1, messageIds: [7] });
		await dm.clearModePin();
		expect(await dm.loadModePin()).toBeNull();
		expect(await dm.loadTopics()).toEqual({
			ownerChatId: 1,
			personal: 10,
			manager: 20,
		});
	});
});

describe("dm-state: what may never happen", () => {
	it("a rename racing a re-pin loses neither", async () => {
		// Both are whole-file read-modify-writes. Without a lock on the path they would each
		// read the same base and write a copy missing the other's work — and these two
		// really do overlap: the mode pin is rewritten on the same start that renames a
		// topic whose name changed in settings.
		const { dm } = setup();
		await dm.saveTopics({ ownerChatId: 1, personal: 10, manager: 20 });
		await dm.saveModePin({ ownerChatId: 1, messageIds: [1] });

		await Promise.all([
			dm.saveTopics({ ownerChatId: 1, personal: 11, manager: 21 }),
			dm.saveModePin({ ownerChatId: 1, messageIds: [2] }),
			dm.saveTopics({ ownerChatId: 1, personal: 12, manager: 22 }),
		]);

		// The last topic write wins (they are the same writer, in order), and the pin — a
		// different writer entirely — is still there.
		expect(await dm.loadTopics()).toEqual({
			ownerChatId: 1,
			personal: 12,
			manager: 22,
		});
		expect(await dm.loadModePin()).toEqual({ ownerChatId: 1, messageIds: [2] });
	});

	it("dropping the pin while the threads are being written keeps the threads", async () => {
		// `clearModePin` is an ERROR path — the pin went wrong, better a new one than a
		// ghost. The topic ids are real Telegram threads holding the owner's history: they
		// must not be collateral.
		const { dm } = setup();
		await Promise.all([
			dm.saveTopics({ ownerChatId: 1, personal: 10, manager: 20 }),
			dm.saveModePin({ ownerChatId: 1, messageIds: [7] }),
			dm.clearModePin(),
		]);
		expect(await dm.loadTopics()).toEqual({
			ownerChatId: 1,
			personal: 10,
			manager: 20,
		});
		expect(await dm.loadModePin()).toBeNull();
	});
});
