import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOpenInterval, memoryDbName } from "../../src/storage/memory";
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

	it("closes one contact's database before opening another's", async () => {
		const { workspace } = fresh();
		const alice = await workspace.for("111");
		await alice.remember({ text: "first", entity: "Alice", tags: ["fact"] });
		const bob = await workspace.for("222");
		await bob.remember({ text: "second", entity: "Bob", tags: ["fact"] });

		// This is the case that made the adapter own the invariant instead of leaving it
		// to the pool's `maxOpen`. Evicting a database from the pool does NOT release its
		// file lock while a handle to it is still alive — so coming back to a contact
		// failed with "database u111 is in use by another process". Its own process.
		const again = await workspace.for("111");
		expect((await again.recall({ query: "first" })).rendered).toContain(
			"first",
		);
		expect((await again.recall({ query: "second" })).rendered).toBe("");
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
		writeFileSync(configPath, buildPlugmemConfig({ kind: "none", dim: 0 }));
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
		writeFileSync(configPath, buildPlugmemConfig({ kind: "none", dim: 0 }));
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

	it("serialises concurrent opens instead of leaking a locked handle", async () => {
		const { workspace } = fresh();
		// The manager reaches this from two directions at once: a turn building its
		// context, and the polling loop recording an inbound message. Interleaved, both
		// would pass the close and both would open — and the second assignment would
		// orphan the first handle, holding that contact's file lock for the life of the
		// process. Every later open of it then fails with "in use by another process",
		// which is the shape of a deadlock even though nothing is waiting.
		const [alice, bob, aliceAgain] = await Promise.all([
			workspace.for("111"),
			workspace.for("222"),
			workspace.for("111"),
		]);
		await alice.remember({ text: "alpha", entity: "Alice", tags: ["fact"] });
		await bob.remember({ text: "beta", entity: "Bob", tags: ["fact"] });
		void aliceAgain;

		// The proof is that both are still reachable afterwards, in either order.
		const back = await workspace.for("111");
		expect((await back.recall({ query: "alpha" })).rendered).toContain("alpha");
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
		// manager_revise and manager_forget, so it can point at what it wants changed.
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

	it("refuses a name that is not a user id rather than inventing one", async () => {
		const { workspace } = fresh();
		// Every caller resolves a real id before reaching here, so this is a bug — and the
		// wrong answer to a bug is a database name that might belong to somebody.
		await expect(workspace.for("../../etc")).rejects.toBeInstanceOf(
			MemoryOpenError,
		);
	});
});
