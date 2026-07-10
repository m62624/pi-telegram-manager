import { describe, expect, it } from "vitest";
import { createConsolidationQueue } from "../../src/storage/consolidation-queue";
import { FakeFs } from "../helpers/fake-fs";

const PATH = "/agent/consolidation-queue.json";

function setup() {
	return createConsolidationQueue(new FakeFs(), PATH);
}

describe("consolidation queue", () => {
	it("upserts by chat, refreshing activity without duplicating", async () => {
		const q = setup();
		await q.upsert({ chatId: "1", userId: "u1", activityAt: 100 });
		await q.upsert({ chatId: "1", userId: "u1", activityAt: 200 });
		const all = await q.all();
		expect(all).toHaveLength(1);
		expect(all[0].activityAt).toBe(200);
	});

	it("returns nothing until an entry has been quiet long enough", async () => {
		const q = setup();
		await q.upsert({ chatId: "1", activityAt: 1000 });
		expect(await q.eligible(1500, 1000)).toBeNull(); // only 500 quiet
		expect((await q.eligible(2500, 1000))?.chatId).toBe("1"); // 1500 quiet
	});

	it("returns the oldest-activity eligible entry first", async () => {
		const q = setup();
		await q.upsert({ chatId: "new", activityAt: 900 });
		await q.upsert({ chatId: "old", activityAt: 100 });
		expect((await q.eligible(5000, 1000))?.chatId).toBe("old");
	});

	it("removes an entry and survives a reload from disk", async () => {
		const fs = new FakeFs();
		const q = createConsolidationQueue(fs, PATH);
		await q.upsert({ chatId: "1", activityAt: 1 });
		await q.upsert({ chatId: "2", activityAt: 2 });
		await q.remove("1");
		const reloaded = createConsolidationQueue(fs, PATH);
		expect((await reloaded.all()).map((e) => e.chatId)).toEqual(["2"]);
	});
});
