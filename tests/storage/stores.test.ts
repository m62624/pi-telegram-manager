import { describe, expect, it } from "vitest";
import { createBusinessStore } from "../../src/storage/business-store";
import {
	type ChatMessageRecord,
	createChatStore,
} from "../../src/storage/chat-store";
import { createTelegramPaths } from "../../src/storage/paths";
import { createSentRegistry } from "../../src/storage/sent-registry";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

function msg(over: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
	return { author: "interlocutor", text: "hi", timestamp: 1, ...over };
}

describe("chat-store", () => {
	it("appends and returns the newest N oldest-first", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths);
		for (let i = 0; i < 5; i++) {
			await store.append("c1", msg({ text: `m${i}`, timestamp: i }));
		}
		const recent = await store.getRecent("c1", 3);
		expect(recent.map((r) => r.text)).toEqual(["m2", "m3", "m4"]);
	});

	it("isolates transcripts per chat", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths);
		await store.append("a", msg({ text: "secretA" }));
		await store.append("b", msg({ text: "hiB" }));
		expect((await store.all("a")).map((r) => r.text)).toEqual(["secretA"]);
		expect((await store.all("b")).map((r) => r.text)).toEqual(["hiB"]);
	});

	it("hasHistory reflects first contact", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths);
		expect(await store.hasHistory("new")).toBe(false);
		await store.append("new", msg());
		expect(await store.hasHistory("new")).toBe(true);
	});

	it("tolerates a corrupt trailing line", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths);
		await store.append("c", msg({ text: "ok" }));
		await fs.appendText(paths.chatFile("c"), "{partial-broken\n");
		expect((await store.all("c")).map((r) => r.text)).toEqual(["ok"]);
	});
});

describe("business-store", () => {
	it("upserts, gets, lists and removes", async () => {
		const fs = new FakeFs();
		const store = createBusinessStore(fs, paths.businessPath);
		await store.upsert({
			id: "bc1",
			userId: "42",
			isEnabled: true,
			canReply: true,
			connectedAt: 1,
			updatedAt: 1,
		});
		expect((await store.get("bc1"))?.canReply).toBe(true);

		await store.upsert({
			id: "bc1",
			userId: "42",
			isEnabled: false,
			connectedAt: 1,
			updatedAt: 2,
		});
		expect((await store.get("bc1"))?.isEnabled).toBe(false);
		expect(await store.all()).toHaveLength(1);

		await store.remove("bc1");
		expect(await store.get("bc1")).toBeNull();
	});
});

describe("sent-registry", () => {
	it("records bot message ids and distinguishes them", async () => {
		const fs = new FakeFs();
		const reg = createSentRegistry(fs, paths.sentRegistryPath);
		await reg.recordSent("c", 100);
		expect(await reg.wasSentByBot("c", 100)).toBe(true);
		expect(await reg.wasSentByBot("c", 101)).toBe(false);
		// Manual owner message id (never recorded) reads as not-bot.
		expect(await reg.wasSentByBot("other", 100)).toBe(false);
	});

	it("bounds retention per chat", async () => {
		const fs = new FakeFs();
		const reg = createSentRegistry(fs, paths.sentRegistryPath, {
			maxPerChat: 3,
		});
		for (let i = 0; i < 5; i++) await reg.recordSent("c", i);
		expect(await reg.wasSentByBot("c", 0)).toBe(false); // evicted
		expect(await reg.wasSentByBot("c", 4)).toBe(true);
	});
});
