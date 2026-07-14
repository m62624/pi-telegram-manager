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
