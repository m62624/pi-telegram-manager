import { describe, expect, it } from "vitest";
import { createTelegramPaths } from "../../src/storage/paths";
import {
	createSingletonStore,
	isSingletonStale,
	type TelegramSingletonRecord,
} from "../../src/storage/singleton-store";
import { FakeFs } from "../helpers/fake-fs";

function record(
	over: Partial<TelegramSingletonRecord> = {},
): TelegramSingletonRecord {
	return {
		mode: "connect",
		pid: 4242,
		instanceId: "abc",
		startedAt: 1000,
		heartbeatAt: 1000,
		...over,
	};
}

describe("isSingletonStale", () => {
	const alive = () => true;
	const dead = () => false;

	it("is never stale for the current pid", () => {
		expect(
			isSingletonStale(record({ pid: 7, heartbeatAt: 0 }), {
				now: 10_000_000,
				ownPid: 7,
				heartbeatTimeoutMs: 5000,
				isPidAlive: dead,
			}),
		).toBe(false);
	});

	it("is stale when the owning process is gone", () => {
		expect(
			isSingletonStale(record(), {
				now: 1000,
				ownPid: 1,
				heartbeatTimeoutMs: 5000,
				isPidAlive: dead,
			}),
		).toBe(true);
	});

	it("is stale when the heartbeat lapsed", () => {
		expect(
			isSingletonStale(record({ heartbeatAt: 1000 }), {
				now: 1000 + 6000,
				ownPid: 1,
				heartbeatTimeoutMs: 5000,
				isPidAlive: alive,
			}),
		).toBe(true);
	});

	it("is fresh when alive and within the heartbeat window", () => {
		expect(
			isSingletonStale(record({ heartbeatAt: 1000 }), {
				now: 1000 + 4000,
				ownPid: 1,
				heartbeatTimeoutMs: 5000,
				isPidAlive: alive,
			}),
		).toBe(false);
	});
});

describe("createSingletonStore", () => {
	const paths = createTelegramPaths("/agent");

	it("saves, loads, updates and clears atomically", async () => {
		const fs = new FakeFs();
		const store = createSingletonStore(fs, paths.singletonPath);

		expect(await store.load()).toBeNull();

		await store.save(record({ mode: "manager", chatId: "111" }));
		expect((await store.load())?.mode).toBe("manager");

		const next = await store.update((cur) =>
			cur ? { ...cur, heartbeatAt: 9999 } : null,
		);
		expect(next?.heartbeatAt).toBe(9999);

		await store.clear();
		expect(await store.load()).toBeNull();
	});

	it("update(() => null) clears the record", async () => {
		const fs = new FakeFs();
		const store = createSingletonStore(fs, paths.singletonPath);
		await store.save(record());
		await store.update(() => null);
		expect(await store.load()).toBeNull();
	});
});
