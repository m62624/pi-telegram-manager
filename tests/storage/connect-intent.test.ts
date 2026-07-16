import { describe, expect, it } from "vitest";
import {
	type ConnectIntent,
	createConnectIntentStore,
	intentApplies,
} from "../../src/storage/connect-intent";
import { FakeFs } from "../helpers/fake-fs";

const PATH = "/connect-intent.json";
const intent = (over: Partial<ConnectIntent> = {}): ConnectIntent => ({
	mode: "connect",
	cwd: "/project",
	armedAt: 1000,
	...over,
});

describe("intentApplies", () => {
	const base = { cwd: "/project", reason: "new", now: 1000, maxAgeMs: 60_000 };

	it("is false without an intent", () => {
		expect(intentApplies(null, base)).toBe(false);
	});

	it("is false for a different project", () => {
		expect(intentApplies(intent({ cwd: "/other" }), base)).toBe(false);
	});

	it("only fires for a switch we caused (new/resume), never a plain launch", () => {
		expect(intentApplies(intent(), { ...base, reason: "new" })).toBe(true);
		expect(intentApplies(intent(), { ...base, reason: "resume" })).toBe(true);
		expect(intentApplies(intent(), { ...base, reason: "startup" })).toBe(false);
		expect(intentApplies(intent(), { ...base, reason: "reload" })).toBe(false);
	});

	it("ignores a note older than the max age (a crash between arm and switch)", () => {
		expect(
			intentApplies(intent({ armedAt: 1000 }), {
				...base,
				now: 1000 + 60_001,
			}),
		).toBe(false);
		expect(
			intentApplies(intent({ armedAt: 1000 }), {
				...base,
				now: 1000 + 60_000,
			}),
		).toBe(true);
	});
});

describe("createConnectIntentStore", () => {
	it("arms, reads back, and clears the note", async () => {
		const store = createConnectIntentStore(new FakeFs(), PATH);
		expect(await store.load()).toBeNull();

		await store.arm(intent({ mode: "mixed", cwd: "/p", armedAt: 42 }));
		expect(await store.load()).toEqual({
			mode: "mixed",
			cwd: "/p",
			armedAt: 42,
		});

		await store.clear();
		expect(await store.load()).toBeNull();
	});

	it("clear is a no-op when there is no note", async () => {
		const store = createConnectIntentStore(new FakeFs(), PATH);
		await expect(store.clear()).resolves.toBeUndefined();
	});
});
