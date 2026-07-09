import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileWriteLock } from "../../src/storage/file-lock";
import { createNodeFs } from "../../src/storage/fs";
import {
	readJson,
	readJsonIfExists,
	TelegramJsonError,
	writeJson,
} from "../../src/storage/json";
import { FakeFs } from "../helpers/fake-fs";

describe("createNodeFs atomic storage", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ptm-fs-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writeTextAtomic + readJson round-trips and creates parents", async () => {
		const fs = createNodeFs();
		const path = join(dir, "nested", "state.json");
		await writeJson(fs, path, { a: 1, b: ["x"] });
		expect(await readJson(fs, path)).toEqual({ a: 1, b: ["x"] });
	});

	it("leaves no temp files behind after an atomic write", async () => {
		const fs = createNodeFs();
		const path = join(dir, "state.json");
		await writeJson(fs, path, { ok: true });
		const entries = await fs.readdir(dir);
		expect(entries).toEqual(["state.json"]);
	});

	it("appendText accumulates JSONL lines", async () => {
		const fs = createNodeFs();
		const path = join(dir, "chat.jsonl");
		await fs.appendText(path, `${JSON.stringify({ n: 1 })}\n`);
		await fs.appendText(path, `${JSON.stringify({ n: 2 })}\n`);
		const lines = (await fs.readText(path)).trim().split("\n");
		expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2]);
	});
});

describe("json helpers", () => {
	it("readJsonIfExists returns null for a missing file", async () => {
		const fs = new FakeFs();
		expect(await readJsonIfExists(fs, "/nope.json")).toBeNull();
	});

	it("readJson throws TelegramJsonError with the path on invalid JSON", async () => {
		const fs = new FakeFs();
		await fs.writeText("/bad.json", "{not json");
		await expect(readJson(fs, "/bad.json")).rejects.toBeInstanceOf(
			TelegramJsonError,
		);
	});
});

describe("withFileWriteLock", () => {
	it("serializes concurrent read-modify-write (no lost update)", async () => {
		const fs = new FakeFs();
		const path = "/counter.json";
		await writeJson(fs, path, { count: 0 });

		const increment = () =>
			withFileWriteLock(path, async () => {
				const current = await readJson<{ count: number }>(fs, path);
				// Yield to interleave without the lock; the lock must still serialize.
				await new Promise((r) => setTimeout(r, 1));
				await writeJson(fs, path, { count: current.count + 1 });
			});

		await Promise.all(Array.from({ length: 20 }, increment));
		expect((await readJson<{ count: number }>(fs, path)).count).toBe(20);
	});

	it("releases the lock even when the operation throws", async () => {
		let ran = false;
		await expect(
			withFileWriteLock("/x", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await withFileWriteLock("/x", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});
});
