import { describe, expect, it } from "vitest";
import { createBusinessStore } from "../../src/storage/business-store";
import {
	type ChatMessageRecord,
	createChatStore,
} from "../../src/storage/chat-store";
import { createContactStore } from "../../src/storage/contact-store";
import { createTelegramPaths } from "../../src/storage/paths";
import { createSentRegistry } from "../../src/storage/sent-registry";
import type { TelegramProfile } from "../../src/telegram/profile";
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

	it("keeps the full append-only log when no retention is set", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths); // retention 0 (default)
		for (let i = 0; i < 10; i++) {
			await store.append("c", msg({ text: `m${i}`, timestamp: i }));
		}
		expect(await store.all("c")).toHaveLength(10);
	});

	it("prunes old messages once the log passes twice the retention window", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths, 3); // window 3 → disk bounded to ~6
		for (let i = 0; i < 10; i++) {
			await store.append("c", msg({ text: `m${i}`, timestamp: i }));
		}
		// The last-N window the model reads is unaffected.
		expect((await store.getRecent("c", 3)).map((r) => r.text)).toEqual([
			"m7",
			"m8",
			"m9",
		]);
		// On disk, old messages were dropped — no more than ~2× the window is kept.
		const all = await store.all("c");
		expect(all.length).toBeLessThanOrEqual(6);
		expect(all.map((r) => r.text)).not.toContain("m0");
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

describe("contact-store", () => {
	const profile = (over: Partial<TelegramProfile> = {}): TelegramProfile => ({
		userId: "42",
		firstName: "Ada",
		username: "ada",
		displayName: "Ada",
		...over,
	});

	it("creates a record on first contact with firstSeen", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		const rec = await store.upsertProfile(profile(), 1000);
		expect(rec.firstSeen).toBe(1000);
		expect(rec.updatedAt).toBe(1000);
		expect(rec.facts).toEqual([]);
		expect(rec.profile.displayName).toBe("Ada");
		expect(await store.get("42")).toEqual(rec);
	});

	it("merges later profiles without dropping known fields, keeping firstSeen", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile({ phoneNumber: "+100" }), 1000);
		// A plain message update lacks the phone number — it must survive.
		const rec = await store.upsertProfile(
			profile({ lastName: "Lovelace", displayName: "Ada Lovelace" }),
			2000,
		);
		expect(rec.firstSeen).toBe(1000);
		expect(rec.updatedAt).toBe(2000);
		expect(rec.profile.phoneNumber).toBe("+100");
		expect(rec.profile.lastName).toBe("Lovelace");
	});

	it("appends important facts, oldest-first", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile(), 1000);
		await store.addFact("42", { text: "likes tea", timestamp: 1100 });
		await store.addFact("42", {
			text: "timezone UTC+3",
			timestamp: 1200,
			source: "manual",
		});
		const facts = await store.getFacts("42");
		expect(facts.map((f) => f.text)).toEqual(["likes tea", "timezone UTC+3"]);
	});

	it("ignores facts for an unknown contact", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.addFact("999", { text: "orphan", timestamp: 1 });
		expect(await store.getFacts("999")).toEqual([]);
		expect(await store.get("999")).toBeNull();
	});

	it("isolates contacts per user id", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile({ userId: "1", displayName: "One" }), 1);
		await store.upsertProfile(profile({ userId: "2", displayName: "Two" }), 1);
		expect((await store.get("1"))?.profile.displayName).toBe("One");
		expect((await store.get("2"))?.profile.displayName).toBe("Two");
	});

	it("clearAllFacts wipes every contact's facts but keeps profiles", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile({ userId: "1", displayName: "One" }), 1);
		await store.upsertProfile(profile({ userId: "2", displayName: "Two" }), 1);
		await store.addFact("1", { text: "a", timestamp: 1 });
		await store.addFact("2", { text: "b", timestamp: 1 });
		await store.clearAllFacts();
		expect(await store.getFacts("1")).toEqual([]);
		expect(await store.getFacts("2")).toEqual([]);
		expect((await store.get("1"))?.profile.displayName).toBe("One");
		expect((await store.get("2"))?.profile.displayName).toBe("Two");
	});

	it("clearAllFacts is a no-op when no contacts exist", async () => {
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await expect(store.clearAllFacts()).resolves.toBeUndefined();
	});
});
