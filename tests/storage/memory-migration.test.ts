import { describe, expect, it } from "vitest";
import { createContactStore } from "../../src/storage/contact-store";
import {
	MEMORY_SCHEMA_VERSION,
	migrateMemory,
} from "../../src/storage/memory-migration";
import { createTelegramPaths } from "../../src/storage/paths";
import type { TelegramProfile } from "../../src/telegram/profile";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

const profile = (userId: string): TelegramProfile => ({
	userId,
	firstName: "X",
	username: "x",
	displayName: "X",
});

describe("migrateMemory", () => {
	it("wipes stale facts on first run and records the version", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile("1"), 1);
		await store.addFact("1", { text: "stale flat fact", timestamp: 1 });

		const ran = await migrateMemory(fs, paths.memoryVersionPath, store);
		expect(ran).toBe(true);
		expect(await store.getFacts("1")).toEqual([]);
		// Profile survives.
		expect((await store.get("1"))?.profile.displayName).toBe("X");
	});

	it("is a no-op once the version marker is current", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile("1"), 1);

		expect(await migrateMemory(fs, paths.memoryVersionPath, store)).toBe(true);
		// A fact added after migration must survive a second start.
		await store.addFact("1", { text: "new fact", timestamp: 2 });
		expect(await migrateMemory(fs, paths.memoryVersionPath, store)).toBe(false);
		expect((await store.getFacts("1")).map((f) => f.text)).toEqual([
			"new fact",
		]);
	});

	it("does not re-run for a marker already at the current version", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await fs.writeTextAtomic(
			paths.memoryVersionPath,
			`${JSON.stringify({ version: MEMORY_SCHEMA_VERSION })}\n`,
		);
		await store.upsertProfile(profile("1"), 1);
		await store.addFact("1", { text: "keep me", timestamp: 1 });
		expect(await migrateMemory(fs, paths.memoryVersionPath, store)).toBe(false);
		expect((await store.getFacts("1")).map((f) => f.text)).toEqual(["keep me"]);
	});
});
