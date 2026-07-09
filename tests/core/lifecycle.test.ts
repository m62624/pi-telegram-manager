import { describe, expect, it } from "vitest";
import {
	createLifecycleController,
	type LifecycleDeps,
} from "../../src/core/lifecycle";
import { createTelegramPaths } from "../../src/storage/paths";
import { createSingletonStore } from "../../src/storage/singleton-store";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

function setup(over: Partial<LifecycleDeps> = {}) {
	const fs = new FakeFs();
	const store = createSingletonStore(fs, paths.singletonPath);
	let clock = 1000;
	const deps: LifecycleDeps = {
		store,
		now: () => clock,
		ownPid: 100,
		instanceId: "inst-a",
		isPidAlive: () => true,
		heartbeatTimeoutMs: 5000,
		...over,
	};
	return {
		fs,
		store,
		deps,
		lifecycle: createLifecycleController(deps),
		tick: (ms: number) => {
			clock += ms;
		},
	};
}

describe("lifecycle default OFF + activation", () => {
	it("is inactive by default", async () => {
		const { lifecycle } = setup();
		expect(await lifecycle.resolveActive()).toBeNull();
	});

	it("activates a mode and persists ownership", async () => {
		const { lifecycle } = setup();
		const res = await lifecycle.activate({ mode: "connect", chatId: "5" });
		expect(res.ok).toBe(true);
		expect((await lifecycle.resolveActive())?.mode).toBe("connect");
	});

	it("enforces mutual exclusion between modes", async () => {
		const { lifecycle } = setup();
		await lifecycle.activate({ mode: "connect" });
		const res = await lifecycle.activate({ mode: "manager" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toMatch(/connect.*active/);
	});

	it("deactivate clears our own record", async () => {
		const { lifecycle } = setup();
		await lifecycle.activate({ mode: "manager", workdir: "/w" });
		await lifecycle.deactivate("manager");
		expect(await lifecycle.resolveActive()).toBeNull();
	});
});

describe("lifecycle crash-reset", () => {
	it("resets a record whose owner process is gone", async () => {
		const { store, fs } = setup();
		// Simulate a record left by a crashed foreign process.
		await store.save({
			mode: "manager",
			pid: 999,
			instanceId: "dead",
			startedAt: 0,
			heartbeatAt: 0,
		});
		const lifecycle = createLifecycleController({
			store,
			now: () => 10_000,
			ownPid: 100,
			isPidAlive: (pid) => pid === 100, // 999 is dead
			heartbeatTimeoutMs: 5000,
		});
		expect(await lifecycle.resolveActive()).toBeNull();
		// Record was cleared from disk.
		expect(await fs.exists(paths.singletonPath)).toBe(false);
	});

	it("resets a record with a lapsed heartbeat even if pid appears alive", async () => {
		const { store } = setup();
		await store.save({
			mode: "connect",
			pid: 999,
			instanceId: "stale",
			startedAt: 0,
			heartbeatAt: 1000,
		});
		const lifecycle = createLifecycleController({
			store,
			now: () => 1000 + 6000, // > timeout
			ownPid: 100,
			isPidAlive: () => true,
			heartbeatTimeoutMs: 5000,
		});
		expect(await lifecycle.resolveActive()).toBeNull();
	});

	it("heartbeat refreshes the owned record", async () => {
		const { lifecycle, store, tick } = setup();
		await lifecycle.activate({ mode: "connect" });
		tick(2000);
		await lifecycle.heartbeat();
		expect((await store.load())?.heartbeatAt).toBe(3000);
	});
});
