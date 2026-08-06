/**
 * The plugmem adapter: a directory of per-contact memories behind {@link MemoryWorkspace}.
 *
 * plugmem is embedded, not served — the engine runs in this process, over files in
 * the extension's own directory, the way SQLite does. So there is no daemon to
 * supervise, no port to secure and no second thing to install: the addon is a
 * dependency like any other.
 *
 * Three decisions are made here rather than left to a caller, because each of them is
 * a property the rest of the system is allowed to assume:
 *
 *  - **`maxOpen: 1`.** The manager answers one chat at a time and consolidates one
 *    contact at a time, so the pool never needs a second handle — and holding it to
 *    one makes "two people's memories are never open together" a fact about the
 *    process rather than a promise about the code. Reopening costs about two
 *    milliseconds.
 *  - **The database name comes from {@link memoryDbName}**, which takes a numeric
 *    Telegram user id and nothing else. No caller passes a name, and no tool has an
 *    argument that could become one.
 *  - **An open failure is not swallowed.** A memory that quietly does not work is a
 *    bot that answers strangers with confident amnesia, on the owner's behalf. It
 *    fails loudly, at start, with the command that fixes it.
 */
import { type Plugmem, Workspace } from "plugmem";
import {
	type ContactMemory,
	isOpenInterval,
	type MemoryFact,
	type MemoryHit,
	type MemoryRecallQuery,
	type MemoryRecallResult,
	type MemorySimilar,
	type MemoryWorkspace,
	type MemoryWrite,
	type MemoryWriteOutcome,
	memoryDbName,
} from "./memory";

/**
 * A memory that will not open, explained in terms of what to do about it.
 *
 * plugmem's own messages are accurate and terse ("config mismatch: stored dim
 * differs"); this adds the half the owner needs — which setting did that, and how to
 * move the data — because the alternative is a stack trace in a terminal they were
 * not looking at.
 */
export class MemoryOpenError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "MemoryOpenError";
	}
}

export interface PlugmemWorkspaceOptions {
	/** Path to the generated `config.toml` (see `plugmem-config.ts`). */
	configPath: string;
	/**
	 * How long a memory may sit unused before {@link MemoryWorkspace.closeIdle}
	 * closes it. An open writer holds the database's exclusive lock, so this is what
	 * lets the owner read their own memory with `plugmem-cli` while the bot runs.
	 */
	idleTimeoutMs: number;
}

/** Whether a thrown error is plugmem refusing a database whose vector width moved. */
function isDimMismatch(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("config mismatch: stored dim")
	);
}

/**
 * Turn a failure to open into something the owner can act on.
 *
 * The dim case is called out by name because it is the one failure that is not a
 * broken install but a legitimate settings change: changing the configured vector
 * width disagrees with the width stored in an existing database. plugmem refuses
 * rather than reinterpreting the file, which is right — and it leaves the owner
 * holding a memory they cannot open until they either migrate it, move it aside, or
 * put the previous setting back.
 */
function openFailure(name: string, error: unknown): MemoryOpenError {
	if (isDimMismatch(error)) {
		return new MemoryOpenError(
			`memory "${name}" was created with a different embedding width than ` +
				"memory.embedder.dim now asks for. plugmem stores the width in the " +
				"database and will not reinterpret it. Either restore the previous " +
				"memory.embedder settings, move the database aside, or migrate the facts:\n" +
				`  plugmem-cli --workspace <memory dir> --config <memory dir>/config.toml --db ${name} export > ${name}.jsonl\n` +
				`  # then, with the new settings in place, into a fresh database:\n` +
				`  plugmem-cli --workspace <memory dir> --config <memory dir>/config.toml --db ${name} import ${name}.jsonl\n` +
				"(vectors are recomputed on import; closed revisions do not survive it)",
			error,
		);
	}
	return new MemoryOpenError(
		`memory "${name}" could not be opened: ${
			error instanceof Error ? error.message : String(error)
		}`,
		error,
	);
}

/** Normalise plugmem's open-interval sentinel to "still true". */
function closedAt(validTo: number): number | undefined {
	return isOpenInterval(validTo) ? undefined : validTo;
}

/**
 * One contact's memory, mapped onto the port.
 *
 * `open()` resolves the database FOR EVERY CALL rather than closing over a handle, and
 * that is the difference between a reference to a person's memory and a reference to
 * an open file. Only one database is open at a time here, so a handle captured on one
 * turn is closed the moment another contact is served — and a caller still holding it
 * gets "this memory is closed", on a path where it did nothing wrong. Resolving per
 * call makes the object mean what the port says it means, and costs a map lookup in
 * the common case where nothing has changed.
 */
function contactMemory(open: () => Promise<Plugmem>): ContactMemory {
	/**
	 * Attach each similar fact's text.
	 *
	 * The engine returns ids and scores — enough for a program, useless for a model,
	 * which has to be shown the sentence it may be contradicting before it can decide
	 * between revising and keeping both. `get` is an in-memory read on an open handle.
	 */
	const withText = (
		db: Plugmem,
		similar: { id: number; score: number; reason: string }[],
	): MemorySimilar[] => {
		const resolved: MemorySimilar[] = [];
		for (const hint of similar) {
			const snapshot = db.get(hint.id);
			if (!snapshot) continue;
			resolved.push({
				id: hint.id,
				text: snapshot.text,
				score: hint.score,
				reason: hint.reason,
			});
		}
		return resolved;
	};

	const write = (input: MemoryWrite) => ({
		text: input.text,
		entity: input.entity,
		tags: input.tags,
		metadata: input.metadata,
		validFrom: input.validFrom,
	});

	const fact = (db: Plugmem, id: number): MemoryFact | null => {
		const snapshot = db.get(id);
		if (!snapshot) return null;
		return {
			id: snapshot.record.id,
			text: snapshot.text,
			tags: db.tagsOf(id),
			metadata: snapshot.metadata,
			recordedAt: snapshot.record.recordedAt,
			validFrom: snapshot.record.validFrom,
			validTo: closedAt(snapshot.record.validTo),
		};
	};

	return {
		async remember(input): Promise<MemoryWriteOutcome> {
			const db = await open();
			const outcome = await db.remember(write(input));
			return { id: outcome.id, similar: withText(db, outcome.similar) };
		},

		async revise(id, input): Promise<MemoryWriteOutcome> {
			const db = await open();
			const outcome = await db.revise(id, write(input));
			return { id: outcome.id, similar: withText(db, outcome.similar) };
		},

		async forget(id): Promise<boolean> {
			return (await open()).forget(id);
		},

		async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
			const db = await open();
			const result = await db.recall({
				query: query.query,
				tags: query.tags,
				entities: query.entities,
				asOf: query.asOf,
				range: query.range,
				k: query.k,
				tokenBudget: query.tokenBudget,
			});
			const hits: MemoryHit[] = result.facts.map((hit) => ({
				id: hit.id,
				score: hit.score,
				recordedAt: hit.recordedAt,
				validFrom: hit.validFrom,
				validTo: closedAt(hit.validTo),
			}));
			return { hits, rendered: result.rendered, truncated: result.truncated };
		},

		async get(id): Promise<MemoryFact | null> {
			return fact(await open(), id);
		},
	};
}

/**
 * Open the workspace at `root`, creating memories on first write.
 *
 * **One database is held open at a time, and the previous one is CLOSED to make room.**
 * That sentence is the whole of this function, and it is not what the pool's `maxOpen`
 * does on its own: a pool evicts a database from its own bookkeeping, but the handle
 * stays alive — and holds the file's exclusive lock — for as long as anything still
 * references it. Measured: after evicting `u111` to open `u222`, the evicted handle
 * still answered queries, and asking the workspace for `u111` again failed with
 * "database u111 is in use by another process". Its own process.
 *
 * So the invariant is enforced here, deterministically, rather than inferred from a
 * cache policy:
 *
 *  - switching contact closes the previous database before opening the next, which is
 *    what makes "two people's memories are never open together" true of the process
 *    and not merely of a data structure;
 *  - staying on the same contact reuses the open handle, so a live back-and-forth does
 *    not reopen a file per turn (an open is ~2 ms, but a needless one is still a lie
 *    about what the bot is doing);
 *  - {@link MemoryWorkspace.closeIdle} closes it outright once nothing has used it,
 *    which is what hands the lock back to the owner's own `plugmem-cli`.
 *
 * `maxOpen: 1` stays on the pool underneath as a second lock on the same door.
 */
export function createPlugmemWorkspace(
	root: string,
	options: PlugmemWorkspaceOptions,
): MemoryWorkspace {
	const workspace = new Workspace(root, {
		// One at a time — see above. Belt to this function's braces.
		maxOpen: 1,
		idleTimeoutMs: options.idleTimeoutMs,
		config: options.configPath,
	});
	/** The one database currently open, if any. */
	let held: { name: string; db: Plugmem; usedAt: number } | null = null;
	/** One `ContactMemory` per name, so repeat callers get the same object. */
	const handles = new Map<string, ContactMemory>();

	/** Close what is open, releasing its file lock. Safe to call twice. */
	const release = (): void => {
		held?.db.close();
		held = null;
	};

	/**
	 * Opens run one at a time, and this is not defensive tidiness — it is the fix for a
	 * leak that would have been permanent.
	 *
	 * "Close the old one, then open the new one" is two steps with an `await` between
	 * them, and the manager reaches this from two directions at once: a turn building
	 * its context, and the Telegram polling loop recording an inbound message. Let two
	 * of those interleave and both pass the close, both open, and the second assignment
	 * overwrites the first — leaving a handle nothing references and nothing can close,
	 * holding that contact's file lock for the life of the process. Every later attempt
	 * to open that memory then fails with "in use by another process", which is exactly
	 * the shape of a deadlock even though nothing is actually waiting.
	 *
	 * A promise chain makes the pair atomic. It cannot itself deadlock: the critical
	 * section awaits only `workspace.open`, which per plugmem's own contract never waits
	 * on a file lock — it succeeds or fails at once — and a failure rejects the chain's
	 * caller while leaving the chain itself resolved for the next one.
	 */
	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work, work);
		// The chain must survive a rejection, or one failed open wedges every later call.
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	/** The open database for `name`, opening it (and closing the other) if need be. */
	const resolve = (name: string): Promise<Plugmem> =>
		serialized(async () => {
			if (held?.name === name) {
				held.usedAt = Date.now();
				return held.db;
			}
			release();
			try {
				const db = await workspace.open(name, true);
				held = { name, db, usedAt: Date.now() };
				return db;
			} catch (error) {
				throw openFailure(name, error);
			}
		});

	return {
		async for(userId: string): Promise<ContactMemory> {
			const name = memoryDbName(userId);
			if (!name) {
				// Not a Telegram user id. Every caller resolves one before reaching here, so
				// this is a bug rather than bad input — and the wrong response to it is to
				// invent a name, because an invented name can collide with a real contact's.
				throw new MemoryOpenError(
					`"${userId}" is not a Telegram user id, so it cannot name a memory`,
				);
			}
			const existing = handles.get(name);
			if (existing) {
				// Resolve it now too, so a caller that only ever uses the returned object
				// still finds a bad configuration at the point it asked, not three lines later.
				await resolve(name);
				return existing;
			}
			await resolve(name);
			const memory = contactMemory(() => resolve(name));
			handles.set(name, memory);
			return memory;
		},
		closeIdle(): void {
			// BOTH handles have to go, and they are two different things: ours, and the
			// pool's own. Measured — closing only ours leaves the file locked, because the
			// pool is still holding it; sweeping only the pool leaves it locked too,
			// because ours is. One real clock for both, so they cannot disagree.
			if (held && Date.now() - held.usedAt >= options.idleTimeoutMs) release();
			workspace.closeIdle();
		},
		async close(): Promise<void> {
			release();
			workspace.close();
		},
	};
}
