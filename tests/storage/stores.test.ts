import { describe, expect, it } from "vitest";
import { createBusinessStore } from "../../src/storage/business-store";
import {
	type ChatMessageRecord,
	createChatStore,
	ownWords,
} from "../../src/storage/chat-store";
import { createContactStore } from "../../src/storage/contact-store";
import { createTelegramPaths } from "../../src/storage/paths";
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

	it("serializes concurrent appends to one chat with no lost write (retention off)", async () => {
		const fs = new FakeFs();
		const store = createChatStore(fs, paths); // retention 0 → the unlocked path
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				store.append("c", msg({ text: `m${i}`, timestamp: i })),
			),
		);
		const texts = (await store.all("c")).map((r) => r.text).sort();
		expect(texts).toHaveLength(20);
		expect(new Set(texts).size).toBe(20);
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

	it("clearAllFacts clears nothing, and says so, when there is nothing to clear", async () => {
		// The count is what tells the owner whether their memory was actually thrown away.
		// A fresh install passes through the memory migration too, and must not be told
		// that facts it never had were "upgraded".
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		expect(await store.clearAllFacts()).toBe(0);
	});

	it("stores a fact once, however many times it is learned", async () => {
		// A memory pass re-runs over a chat whenever it gets new messages, and it
		// re-confirms what it confirmed before: the same sentence, verified against the
		// same quote, genuinely true again. Appended blindly, "true again" became "stored
		// again" — in the owner's live store, one contact's memory was five facts, three
		// of which were the same line.
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile(), 1000);
		await store.appendFacts("42", [
			{ text: "Prefers voice notes", timestamp: 1 },
		]);
		await store.appendFacts("42", [
			{ text: "prefers voice notes.", timestamp: 2 }, // same sentence, different dress
			{ text: "Works nights", timestamp: 2 },
		]);
		await store.addFact("42", {
			text: "  Prefers   voice notes  ",
			timestamp: 3,
		});
		const facts = await store.getFacts("42");
		expect(facts.map((f) => f.text)).toEqual([
			"Prefers voice notes",
			"Works nights",
		]);
	});

	it("does not let a repeat evict a real fact through the cap", async () => {
		// `factsLimit` keeps the NEWEST facts. A repeat that is stored is a repeat that
		// pushes something true off the end.
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile(), 1000);
		await store.appendFacts(
			"42",
			[
				{ text: "Works nights", timestamp: 1 },
				{ text: "Prefers voice notes", timestamp: 1 },
			],
			2,
		);
		await store.appendFacts(
			"42",
			[{ text: "Prefers voice notes", timestamp: 2 }],
			2,
		);
		expect((await store.getFacts("42")).map((f) => f.text)).toEqual([
			"Works nights",
			"Prefers voice notes",
		]);
	});

	it("evicts the least valuable fact when full, not simply the oldest", async () => {
		// It used to be `slice(-limit)`: keep the newest, whatever they are. So a contact's
		// name and city — learned the day they first wrote — were evicted by a week of "is
		// at the office today", and the memory that survived was the one worth the least.
		// `context` is documented as background that may go stale; `identity` is who the
		// person IS and `agreement` is what was promised them. Age is the tie-break now.
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile(), 1000);
		await store.appendFacts(
			"42",
			[
				{ text: "Lives two hours ahead", timestamp: 1, kind: "identity" },
				{ text: "Is travelling this week", timestamp: 2, kind: "context" },
				{ text: "Was promised a refund", timestamp: 3, kind: "agreement" },
			],
			3,
		);
		await store.appendFacts(
			"42",
			[{ text: "Prefers short replies", timestamp: 4, kind: "preference" }],
			3,
		);
		// The disposable one went; who they are and what they were promised stayed — and
		// the survivors are still in the order they were learned.
		expect((await store.getFacts("42")).map((f) => f.text)).toEqual([
			"Lives two hours ahead",
			"Was promised a refund",
			"Prefers short replies",
		]);
	});

	it("forgets a fact by what it says, however it is dressed", async () => {
		// The unlearning path (`manager_forget`): the pass names a fact by its text, and a
		// trailing full stop or a stray double space must not save it from being dropped —
		// the same normalisation that stops the same sentence being stored twice.
		const fs = new FakeFs();
		const store = createContactStore(fs, paths);
		await store.upsertProfile(profile(), 1000);
		await store.appendFacts("42", [
			{ text: "Works at a bank", timestamp: 1, kind: "identity" },
			{ text: "Prefers voice notes", timestamp: 2, kind: "preference" },
		]);
		expect(await store.removeFacts("42", ["  works at a BANK. "])).toBe(1);
		expect((await store.getFacts("42")).map((f) => f.text)).toEqual([
			"Prefers voice notes",
		]);
		// Removing what is not there removes nothing, and says so.
		expect(await store.removeFacts("42", ["never knew this"])).toBe(0);
		expect(await store.removeFacts("unknown-contact", ["anything"])).toBe(0);
	});
});

describe("ownWords", () => {
	const record = (over: Partial<ChatMessageRecord>): ChatMessageRecord => ({
		author: "interlocutor",
		text: "",
		timestamp: 1,
		...over,
	});

	it("is what the author typed, never the message they answered", () => {
		expect(
			ownWords(
				record({
					text: "nice",
					context:
						'[answering an earlier message by Owner, which said: "the rate is 60"]',
				}),
			),
		).toBe("nice");
	});

	it("is empty for a forward — none of it is theirs", () => {
		expect(
			ownWords(
				record({
					text: "a long article somebody else wrote",
					forwarded: true,
					context:
						"[forwarded — the text below was written by Alice, not by the sender]",
				}),
			),
		).toBe("");
	});

	it("strips the context a legacy record merged into its text", () => {
		// Pre-`context` records kept the quoted message inside the speaker's own line,
		// which is how the owner's words became "evidence" for facts about a contact.
		const legacy = record({
			text: '[answering an earlier message by Owner, which said: "the rate is 60"]\nnice',
		});
		expect(ownWords(legacy)).toBe("nice");
		expect(ownWords(legacy)).not.toContain("the rate is 60");
	});

	it("keeps nothing from a legacy forward", () => {
		expect(
			ownWords(
				record({
					text: "[forwarded from: Alice]\nsomething Alice wrote",
				}),
			),
		).toBe("");
	});

	it("leaves an ordinary message untouched", () => {
		expect(ownWords(record({ text: "I live in Berlin" }))).toBe(
			"I live in Berlin",
		);
	});
});
