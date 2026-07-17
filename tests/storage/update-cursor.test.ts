import { describe, expect, it } from "vitest";
import { createUpdateCursor } from "../../src/storage/update-cursor";
import { FakeFs } from "../helpers/fake-fs";

describe("createUpdateCursor", () => {
	it("claims a new id once, then skips its redelivery and older backlog", async () => {
		const cursor = createUpdateCursor(new FakeFs(), "/cursor.json");
		expect(await cursor.claim(10)).toBe(true); // new — process it
		expect(await cursor.claim(10)).toBe(false); // redelivery — skip
		expect(await cursor.claim(9)).toBe(false); // older backlog — skip
		expect(await cursor.claim(11)).toBe(true); // advances — process it
	});

	it("survives a restart: a fresh instance still skips a seen id", async () => {
		const fs = new FakeFs();
		expect(await createUpdateCursor(fs, "/c.json").claim(100)).toBe(true);
		// A new process (the shutdown case): Telegram redelivers #100.
		const afterRestart = createUpdateCursor(fs, "/c.json");
		expect(await afterRestart.claim(100)).toBe(false);
		expect(await afterRestart.claim(101)).toBe(true);
	});

	it("processes a non-finite id rather than dropping it", async () => {
		const cursor = createUpdateCursor(new FakeFs(), "/c.json");
		expect(await cursor.claim(Number.NaN)).toBe(true);
	});

	it("serializes concurrent claims of the same id: exactly one wins", async () => {
		const cursor = createUpdateCursor(new FakeFs(), "/c.json");
		const results = await Promise.all([cursor.claim(5), cursor.claim(5)]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
});
