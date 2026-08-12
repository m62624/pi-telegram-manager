import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isOpenInterval,
	MEMORY_EPISODE_ENTITY,
	MEMORY_EPISODE_RELATION,
	memoryDbName,
} from "../../src/storage/memory";
import {
	createPlugmemWorkspace,
	MemoryOpenError,
} from "../../src/storage/memory-plugmem";
import { buildPlugmemConfig } from "../../src/storage/plugmem-config";
import { type TempMemory, tempMemory } from "../helpers/temp-memory";

/**
 * The memory adapter, against the real engine.
 *
 * Nothing here is mocked, and that is the point: what these assert are the properties
 * the rest of the project is allowed to assume about a contact's memory — above all
 * that one contact's facts cannot be reached from another contact's turn.
 */

let open: TempMemory | null = null;

afterEach(async () => {
	await open?.dispose();
	open = null;
});

function fresh(): TempMemory {
	open = tempMemory();
	return open;
}

describe("memoryDbName", () => {
	it("turns a Telegram user id into a name that cannot be a path", () => {
		expect(memoryDbName("123456789")).toBe("u123456789");
	});

	it("refuses anything that is not a plain user id, rather than mangling it", () => {
		// Mangling is the dangerous option: a mangled name can collide with a real
		// contact's, and a collision here is one person's facts in another person's chat.
		for (const bad of ["../escape", "5/6", "", "abc", "5.5", "-5"]) {
			expect(memoryDbName(bad)).toBeNull();
		}
	});
});

describe("isOpenInterval", () => {
	it("reads plugmem's open-end sentinel as 'still true'", () => {
		// It arrives as u64::MAX, which is far past the safe-integer ceiling — comparing
		// it to a timestamp is meaningless and formatting it as a date is a lie.
		expect(isOpenInterval(18_446_744_073_709_552_000)).toBe(true);
		expect(isOpenInterval(Date.now())).toBe(false);
	});
});

describe("a contact's memory", () => {
	it("keeps each contact's facts unreachable from another's", async () => {
		const { workspace } = fresh();
		const alice = await workspace.for("111");
		await alice.remember({
			text: "lives in Almaty",
			entity: "Alice",
			tags: ["fact", "identity"],
		});
		const bob = await workspace.for("222");
		await bob.remember({
			text: "lives in Berlin",
			entity: "Bob",
			tags: ["fact", "identity"],
		});

		// The property the whole design rests on. It is not enforced by a filter over one
		// shared store — there is no shared store, and no argument anywhere that could
		// name the other database.
		const seen = await bob.recall({ query: "lives" });
		expect(seen.rendered).toContain("Berlin");
		expect(seen.rendered).not.toContain("Almaty");
	});

	it("comes back to a contact after serving another one", async () => {
		const { workspace } = fresh();
		const alice = await workspace.for("111");
		await alice.remember({ text: "first", entity: "Alice", tags: ["fact"] });
		const bob = await workspace.for("222");
		await bob.remember({ text: "second", entity: "Bob", tags: ["fact"] });

		// Switching contact and switching back was the case that used to break: a
		// database evicted from the pool did NOT release its file lock while a handle to
		// it was alive, so coming back failed with "database u111 is in use by another
		// process" — its own process. plugmem 0.9 hands out references that own no
		// handle, which is what makes this ordinary again.
		const again = await workspace.for("111");
		expect((await again.recall({ query: "first" })).rendered).toContain(
			"first",
		);
		expect((await again.recall({ query: "second" })).rendered).toBe("");
	});

	it("answers nothing for a contact who has no memory yet", async () => {
		const { workspace } = fresh();
		const stranger = await workspace.for("111");

		// A read verb on a name with no file rejects with "no database named u111",
		// because a workspace is right to diagnose a misspelled name. Here every name
		// came from a Telegram user id, so the only way to reach it is a contact nobody
		// has stored anything about — and the answer to that is nothing, not an error
		// that would take the whole turn down with it.
		expect(await stranger.recall({ query: "anything" })).toEqual({
			hits: [],
			rendered: "",
			truncated: false,
		});
		expect(await stranger.get(0)).toBeNull();
	});

	it("reuses the open database while the same contact keeps talking", async () => {
		const { workspace } = fresh();
		const first = await workspace.for("111");
		const second = await workspace.for("111");
		// A live back-and-forth must not reopen a file per turn.
		expect(second).toBe(first);
	});

	it("lets go of the lock once nothing has used the memory", async () => {
		// A liveness property, not a memory one: an open writer holds the database's
		// exclusive lock, so a bot that never let go would make the owner's own memory
		// unreachable from `plugmem-cli` for as long as it ran.
		//
		// Two handles have to go, and finding that out is why this test is here: ours,
		// and the pool's own. Closing either alone leaves the file locked.
		const root = mkdtempSync(join(tmpdir(), "ptm-idle-"));
		const configPath = join(root, "config.toml");
		writeFileSync(configPath, buildPlugmemConfig({ enabled: false, dim: 0 }));
		const workspace = createPlugmemWorkspace(root, {
			configPath,
			idleTimeoutMs: 1,
		});
		try {
			const memory = await workspace.for("111");
			await memory.remember({ text: "held", entity: "Alice", tags: ["fact"] });
			await new Promise((resolve) => setTimeout(resolve, 20));
			workspace.closeIdle();

			// Proof the lock really was released: another workspace opens the same file.
			const other = createPlugmemWorkspace(root, {
				configPath,
				idleTimeoutMs: 60_000,
			});
			try {
				const reopened = await other.for("111");
				expect((await reopened.recall({ query: "held" })).rendered).toContain(
					"held",
				);
			} finally {
				await other.close();
			}
		} finally {
			await workspace.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases everything on close, so a restart is not locked out", async () => {
		const root = mkdtempSync(join(tmpdir(), "ptm-close-"));
		const configPath = join(root, "config.toml");
		writeFileSync(configPath, buildPlugmemConfig({ enabled: false, dim: 0 }));
		const first = createPlugmemWorkspace(root, {
			configPath,
			idleTimeoutMs: 60_000,
		});
		const memory = await first.for("111");
		await memory.remember({
			text: "survives",
			entity: "Alice",
			tags: ["fact"],
		});
		await first.close();

		// What `stopManager` does. A mode that stopped without letting go would lock the
		// owner out of their own memory until the whole Pi process ended.
		const second = createPlugmemWorkspace(root, {
			configPath,
			idleTimeoutMs: 60_000,
		});
		try {
			const reopened = await second.for("111");
			expect((await reopened.recall({ query: "survives" })).rendered).toContain(
				"survives",
			);
		} finally {
			await second.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("queues concurrent verbs instead of failing the second one", async () => {
		const { workspace } = fresh();
		const alice = await workspace.for("111");
		const bob = await workspace.for("222");

		// The manager reaches this from two directions at once: a turn building its
		// context, and the polling loop recording an inbound message. `maxOpen: 1` is
		// what keeps two people's memories from being open together — but a pool at its
		// ceiling REFUSES the second caller ("workspace has 1 active databases") rather
		// than waiting for the first, so without a queue of our own the second write —
		// the fact a person just stated — is lost to an error about a limit nobody set.
		const done = await Promise.all([
			alice.remember({ text: "alpha", entity: "Alice", tags: ["fact"] }),
			bob.remember({ text: "beta", entity: "Bob", tags: ["fact"] }),
			alice.remember({ text: "alpha again", entity: "Alice", tags: ["fact"] }),
			bob.recall({ query: "beta" }),
		]);
		expect(done).toHaveLength(4);

		// Both landed, in their own memories, and neither is reachable from the other.
		const back = await workspace.for("111");
		expect((await back.recall({ query: "alpha" })).rendered).toContain("alpha");
		expect((await back.recall({ query: "beta" })).rendered).toBe("");
		const other = await workspace.for("222");
		expect((await other.recall({ query: "beta" })).rendered).toContain("beta");
	});

	it("keeps serving after one open has failed", async () => {
		const { workspace } = fresh();
		// A rejection must not wedge the queue behind it: one bad name would otherwise
		// take every later contact's memory with it.
		await expect(workspace.for("not-an-id")).rejects.toBeInstanceOf(
			MemoryOpenError,
		);
		const memory = await workspace.for("111");
		await memory.remember({ text: "still works", entity: "A", tags: ["fact"] });
		expect((await memory.recall({ query: "works" })).rendered).toContain(
			"still works",
		);
	});

	it("reports what a new fact may be contradicting, and does not merge it", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const first = await memory.remember({
			text: "works at a bank",
			entity: "Alice",
			tags: ["fact", "identity"],
		});
		expect(first.similar).toEqual([]);

		const second = await memory.remember({
			text: "works at a bank in the city",
			entity: "Alice",
			tags: ["fact", "identity"],
		});
		// This is what removed a whole inference from the memory pass: the collision
		// arrives attached to the write that caused it, with the id needed to fix it —
		// instead of the entire memory being read back and the model asked what is stale.
		expect(second.similar.map((hint) => hint.id)).toContain(first.id);
		expect(second.similar[0].text).toBe("works at a bank");
		// Surfaced, never resolved: both are still there until somebody decides.
		const both = await memory.recall({ query: "bank" });
		expect(both.hits).toHaveLength(2);
	});

	it("refuses to duplicate a fact, and allocates nothing when it refuses", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const first = await memory.remember({
			text: "works at a bank",
			entity: "Alice",
			tags: ["fact", "identity"],
		});

		const blocked = await memory.rememberGuarded({
			text: "works at a bank in town",
			entity: "Alice",
			tags: ["fact", "identity"],
		});
		expect(blocked.status).toBe("blocked");
		expect(blocked.id).toBeUndefined();
		expect(blocked.similar.map((hint) => hint.id)).toEqual([first.id]);
		// The text, not just the id: a model cannot choose between revising and keeping
		// both without being shown the sentence it may be contradicting.
		expect(blocked.similar[0].text).toBe("works at a bank");
		expect(blocked.similar[0].reason).toBe("LexicalOverlap");
		// Nothing was written, so nothing has to be undone.
		expect((await memory.recall({ query: "bank" })).hits).toHaveLength(1);
	});

	it("stores a fact that is merely related to one it already holds", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "wants to play a new game without spoilers",
			entity: "Alice",
			tags: ["fact", "preference"],
		});

		// The distinction the whole guard exists for. A recall asked about the second
		// statement returns the first — it is the closest thing in the memory, and a
		// recall always answers with its closest thing. The detector compares them and
		// says they are not the same statement, which is the truth: one is a request
		// about how to talk to them, the other something they happen to know.
		const stored = await memory.rememberGuarded({
			text: "knows the lore of a long-running series well",
			entity: "Alice",
			tags: ["fact", "context"],
		});
		expect(stored.status).toBe("stored");
		expect(stored.similar).toEqual([]);
		expect((await memory.recall({ entities: ["Alice"] })).hits).toHaveLength(2);
	});

	it("does not let a message block the fact drawn from it", async () => {
		// Why episodes are filed under their own subject. The detector is scoped to the
		// entity a write names, so an episode on the contact is a candidate for every
		// fact about them — and a fact IS usually a paraphrase of what they just said.
		// Filed together, this pair scores 0.625 and the write is refused, naming the
		// person's own message as the fact to revise.
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "I play guitar every evening with friends",
			entity: MEMORY_EPISODE_ENTITY,
			tags: ["episode", "message"],
		});

		const stored = await memory.rememberGuarded({
			text: "plays guitar every evening with friends",
			entity: "Alice",
			tags: ["fact", "preference"],
		});
		expect(stored.status).toBe("stored");
	});

	it("still catches a duplicate after a long conversation", async () => {
		// The other half, and the one that is silent. The detector compares against the
		// entity's 32 most recent facts, so episodes on the contact push every earlier
		// fact out of the window: after an ordinary chat, `telegram_manager_remember` stops
		// recognising what it already holds and the memory quietly accumulates copies.
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const fact = {
			text: "works as a paramedic in the north district",
			entity: "Alice",
			tags: ["fact", "identity"],
		};
		await memory.rememberGuarded(fact);
		for (let i = 0; i < 40; i += 1) {
			await memory.remember({
				text: `unrelated chatter number ${i}`,
				entity: MEMORY_EPISODE_ENTITY,
				tags: ["episode", "message"],
			});
		}

		expect((await memory.rememberGuarded(fact)).status).toBe("blocked");
	});

	it("keeps the episodes reachable from the contact, one hop away", async () => {
		// What the link buys. A recall anchored on the contact walks their edges, so
		// asking by tag alone — with no words to search on — still answers with what
		// they said, even though it is no longer filed under their name.
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "Alice is a paramedic",
			entity: "Alice",
			tags: ["fact", "identity"],
		});
		await memory.remember({
			text: "see you at the rehearsal",
			entity: MEMORY_EPISODE_ENTITY,
			tags: ["episode", "message"],
		});
		await memory.link("Alice", MEMORY_EPISODE_RELATION, MEMORY_EPISODE_ENTITY);

		const found = await memory.recall({
			entities: ["Alice"],
			tags: ["episode", "message"],
		});
		expect(found.rendered).toContain("see you at the rehearsal");
	});

	it("reaches a topic's own facts from the contact through a link", async () => {
		// The topic graph. A fact filed under a topic entity is its own node — a recall
		// anchored on the contact walks the edge and pulls it in, the same as the
		// contact/episode link above (`ann`/`bob` in the plugmem skill).
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "Alice enjoys strategy games",
			entity: "Alice",
			tags: ["fact", "preference"],
		});
		await memory.remember({
			text: "is a two-player strategy game played on a checkered board",
			entity: "chess",
			tags: ["fact", "context"],
		});
		await memory.link("Alice", "involved_in", "chess");

		const found = await memory.recall({ entities: ["Alice"] });
		expect(found.rendered).toContain("checkered board");
	});

	it("stops reaching a topic once the link is closed, but as-of still can", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "is a two-player strategy game",
			entity: "chess",
			tags: ["fact", "context"],
		});
		await memory.link("Alice", "involved_in", "chess");
		const beforeUnlink = Date.now();
		// A real gap, not just a captured instant: the edge's own open/close times are
		// the engine's wall clock, and without daylight between them a fast run can tie
		// `beforeUnlink` with the unlink's own timestamp in the same millisecond.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const closed = await memory.unlink("Alice", "involved_in", "chess");
		expect(closed).toBe(true);

		const now = await memory.recall({ entities: ["Alice"] });
		expect(now.rendered).not.toContain("two-player strategy game");

		const then = await memory.recall({
			entities: ["Alice"],
			asOf: beforeUnlink,
		});
		expect(then.rendered).toContain("two-player strategy game");
	});

	it("says plainly when there was no link to close", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		expect(await memory.unlink("Alice", "involved_in", "chess")).toBe(false);
	});

	it("closes a superseded fact instead of erasing it", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const original = await memory.remember({
			text: "works at a bank",
			entity: "Alice",
			tags: ["fact", "identity"],
			validFrom: 1_000,
		});
		await memory.revise(original.id, {
			text: "freelances",
			entity: "Alice",
			tags: ["fact", "identity"],
			validFrom: 2_000,
		});

		const now = await memory.recall({ entities: ["Alice"], tags: ["fact"] });
		expect(now.rendered).toContain("freelances");
		expect(now.rendered).not.toContain("works at a bank");

		// The difference between a memory that changed its mind and one that was edited:
		// the old claim is still on file, with the interval that says when it held.
		const before = await memory.get(original.id);
		expect(before?.text).toBe("works at a bank");
		expect(before?.validTo).toBe(2_000);
	});

	it("answers about a window of when it learned things", async () => {
		// The knowledge axis, which is what "what came up last month" asks about — and
		// past the transcript's pruning window the memory is the only thing that can
		// answer it at all.
		//
		// `recordedAt` is stamped by the engine from its own clock, and `validFrom` does
		// NOT move it. A window expressed in the conversation's own dates would filter on
		// an axis nothing here ever set, so the boundary is taken from the clock, between
		// the two writes.
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "agreed to ship on the twelfth",
			entity: "Alice",
			tags: ["fact", "agreement"],
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		const between = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 2));
		await memory.remember({
			text: "moved to a new flat",
			entity: "Alice",
			tags: ["fact", "identity"],
		});

		// Alone, because `range` is one of the four SOURCES and not a filter over the
		// others: added to an entity anchor it contributes the period while the anchor
		// goes on contributing everything else, and the answer silently stops being
		// about the period at all. Run by itself it is exactly the window.
		const earlier = await memory.recall({ range: [0, between] });
		expect(earlier.rendered).toContain("ship on the twelfth");
		expect(earlier.rendered).not.toContain("new flat");

		const later = await memory.recall({ range: [between, Date.now() + 1] });
		expect(later.rendered).toContain("new flat");
		expect(later.rendered).not.toContain("ship on the twelfth");

		// The half that decides how the tool exposes this.
		const mixed = await memory.recall({
			entities: ["Alice"],
			range: [0, between],
		});
		expect(mixed.rendered).toContain("new flat");
	});

	it("answers as it stood then, not as it stands now", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const learned = Date.now();
		const original = await memory.remember({
			text: "works at a bank",
			entity: "Alice",
			tags: ["fact", "identity"],
			validFrom: learned,
		});
		// The successor takes over later on the TRUTH axis, which is what closes the
		// original's interval. Both were recorded now, a moment apart.
		await memory.revise(original.id, {
			text: "freelances",
			entity: "Alice",
			tags: ["fact", "identity"],
			validFrom: learned + 10_000,
		});

		const then = await memory.recall({
			entities: ["Alice"],
			asOf: learned + 1_000,
		});
		expect(then.rendered).toContain("works at a bank");
		expect(then.rendered).not.toContain("freelances");

		// And the trap worth knowing before offering this to a model: `asOf` moves BOTH
		// clocks, so an instant before the memory recorded anything answers with nothing
		// — correctly, since it genuinely knew nothing then.
		expect(
			(await memory.recall({ entities: ["Alice"], asOf: learned - 1_000 }))
				.rendered,
		).toBe("");
	});

	it("stores a batch in order, with an id for each", async () => {
		// What the legacy import moves a contact's facts with: one operation, so either
		// the whole contact arrives or none of it does and the JSON it came from is left
		// alone for the next start to retry.
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const outcomes = await memory.rememberMany([
			{ text: "lives in Almaty", entity: "Alice", tags: ["fact", "identity"] },
			{
				text: "prefers voice notes",
				entity: "Alice",
				tags: ["fact", "preference"],
			},
		]);
		expect(outcomes.map((outcome) => outcome.id)).toEqual([0, 1]);
		expect((await memory.recall({ entities: ["Alice"] })).hits).toHaveLength(2);
		// An empty batch is not a write: it must not create the database.
		const stranger = await workspace.for("222");
		expect(await stranger.rememberMany([])).toEqual([]);
		expect((await stranger.recall({ query: "anything" })).rendered).toBe("");
	});

	it("drops a forgotten fact from recall", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const wrong = await memory.remember({
			text: "hates coffee",
			entity: "Alice",
			tags: ["fact", "preference"],
		});
		expect(await memory.forget(wrong.id)).toBe(true);
		expect((await memory.recall({ query: "coffee" })).rendered).toBe("");
		// Twice, and an id that was never there at all: the engine answers the first
		// with `false` and rejects the second, and "was there anything to drop" has one
		// answer for both.
		expect(await memory.forget(wrong.id)).toBe(false);
		expect(await memory.forget(4242)).toBe(false);
	});

	it("filters by tag, so episodes and facts can be asked for separately", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		await memory.remember({
			text: "prefers voice notes",
			entity: "Alice",
			tags: ["fact", "preference"],
		});
		await memory.remember({
			text: "asked about the invoice",
			entity: "Alice",
			tags: ["episode", "message"],
		});
		const facts = await memory.recall({ entities: ["Alice"], tags: ["fact"] });
		expect(facts.rendered).toContain("voice notes");
		expect(facts.rendered).not.toContain("invoice");
	});

	it("renders each line with the id its own tools take", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const stored = await memory.remember({
			text: "prefers mornings",
			entity: "Alice",
			tags: ["fact", "preference"],
		});
		// A block the model can act on: `[fN]` in the text IS the argument for
		// telegram_manager_revise and telegram_manager_forget, so it can point at what it wants changed.
		expect((await memory.recall({ query: "mornings" })).rendered).toContain(
			`[f${stored.id}]`,
		);
	});

	it("says nothing, rather than something empty, when nothing matches", async () => {
		const { workspace } = fresh();
		const memory = await workspace.for("111");
		const nothing = await memory.recall({ query: "quite unrelated" });
		expect(nothing.rendered).toBe("");
		expect(nothing.hits).toEqual([]);
	});

	it("finds every memory to rebuild from the directory, not the registry", async () => {
		const { workspace } = fresh();
		for (const userId of ["222", "111"]) {
			const memory = await workspace.for(userId);
			await memory.remember({ text: "held", entity: "A", tags: ["fact"] });
		}

		// Two ways to discover nothing, both of which would report success. plugmem's own
		// `entries()` reads a REGISTRY that `describe()` fills, and nothing here
		// describes a contact — so it answers with an empty list however many memories
		// exist. And on disk a memory that has just been written to is a journal and a
		// lock: its snapshot is written at a checkpoint, so looking for `.plugmem` alone
		// finds the idle memories and skips the busy ones.
		const seen: string[] = [];
		await expect(
			workspace.reembed((name) => {
				seen.push(name);
			}),
			// With no embedder configured there is nothing to rebuild WITH, and that is
			// the engine's answer rather than a silent no-op — but it can only give it
			// once it has been handed a memory that exists.
		).rejects.toThrow(/embedding provider/);
		expect(seen).toEqual(["u111"]);
	});

	it("has nothing to rebuild before anyone has a memory", async () => {
		const { workspace } = fresh();
		expect(await workspace.reembed()).toEqual([]);
	});

	it("refuses a name that is not a user id rather than inventing one", async () => {
		const { workspace } = fresh();
		// Every caller resolves a real id before reaching here, so this is a bug — and the
		// wrong answer to a bug is a database name that might belong to somebody.
		await expect(workspace.for("../../etc")).rejects.toBeInstanceOf(
			MemoryOpenError,
		);
	});
});
