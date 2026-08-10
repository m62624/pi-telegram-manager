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
 *  - **`maxOpen: 1`, and one memory verb in flight at a time.** The manager answers
 *    one chat and consolidates one contact at a time, so the pool never needs a second
 *    slot — and holding it to one makes "two people's memories are never open
 *    together" a fact about the process rather than a promise about the code. The pool
 *    enforces the ceiling by REFUSING a second concurrent memory ("workspace has 1
 *    active databases"), not by waiting for the first, so the queue below is what turns
 *    that ceiling into a wait; see {@link createPlugmemWorkspace}.
 *  - **The database name comes from {@link memoryDbName}**, which takes a numeric
 *    Telegram user id and nothing else. No caller passes a name, and no tool has an
 *    argument that could become one.
 *  - **A memory that will not answer is not swallowed.** A memory that quietly does
 *    not work is a bot that answers strangers with confident amnesia, on the owner's
 *    behalf. It fails loudly, with the command that fixes it.
 *
 * **What plugmem 0.9 changed.** `Workspace.open()` used to hand out a `Plugmem` handle
 * that owned the file's lock for as long as anything referenced it, which is what the
 * previous version of this file spent most of its length defending against: an evicted
 * handle kept its lock, so coming back to a contact failed with "in use by another
 * process" — its own process. 0.9 replaced handles with `Workspace.memory(name)`, a
 * logical reference that owns nothing; each verb takes a scoped lease and gives it
 * back. The bookkeeping that reference-counted handles by hand is gone with it.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Workspace, type WorkspaceMemory } from "plugmem";
import { COMMANDS } from "../constants";
import {
	type ContactMemory,
	isOpenInterval,
	type MemoryFact,
	type MemoryGuardedOutcome,
	type MemoryHit,
	type MemoryRecallQuery,
	type MemoryRecallResult,
	type MemoryReembedReport,
	type MemorySimilar,
	type MemoryWorkspace,
	type MemoryWrite,
	type MemoryWriteOutcome,
	memoryDbName,
} from "./memory";

/**
 * A memory that will not answer, explained in terms of what to do about it.
 *
 * plugmem's own messages are accurate and terse ("vector space mismatch: stored …");
 * this adds the half the owner needs — which setting did that, and how to move the
 * data — because the alternative is a stack trace in a terminal they were not looking
 * at.
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

/** Where the workspace keeps the databases themselves. */
const DB_SUBDIR = "db";
/** …and what one is called: `u123` + this, plus a journal, a lock and snapshots. */
const DB_SUFFIX = ".plugmem";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the failure is simply "this contact has no memory file yet".
 *
 * In 0.9 a write verb creates the database and a READ verb does not: it rejects with
 * `no database named u123 …`. That is right for a workspace where a misspelled name
 * should be diagnosed, and wrong for us — every name here was built from a Telegram
 * user id by {@link memoryDbName}, so the only way to reach this is a contact nobody
 * has stored a fact about yet, and the honest answer to "what do you remember about
 * them" is nothing. Matching the message is not ideal; the code is `PLUGMEM_ENGINE`,
 * shared with every other engine failure, so there is nothing narrower to test.
 */
function isMissingDatabase(error: unknown): boolean {
	return message(error).includes("no database named");
}

/** Whether plugmem is refusing to mix two embedding models' vectors in one index. */
function isVectorSpaceMismatch(error: unknown): boolean {
	return message(error).includes("vector space mismatch");
}

/**
 * Whether the failure is "there is no fact with that id".
 *
 * The engine distinguishes a tombstoned fact (`forget` answers `false`) from one that
 * never existed (`forget` rejects). The port draws no such line — "was there anything
 * there" has one answer, and both of these are no — so the rejection is folded back
 * into the answer here, where the difference is still visible enough to explain.
 */
function isMissingFact(error: unknown): boolean {
	return /^fact \d+ not found$/.test(message(error));
}

/**
 * Turn a failure to answer into something the owner can act on.
 *
 * The vector-space case is called out by name because it is the one failure that is
 * not a broken install but a legitimate settings change: pointing `memory.embedder` at
 * a different model leaves every stored vector describing the old one. plugmem refuses
 * to mix them rather than returning quiet nonsense, which is right — and it leaves the
 * owner with a memory that answers nothing at all until the vectors are rebuilt. That
 * is one command, and this says which.
 */
function memoryFailure(name: string, error: unknown): MemoryOpenError {
	if (isVectorSpaceMismatch(error)) {
		return new MemoryOpenError(
			`memory "${name}" was written with a different embedding model than ` +
				"memory.embedder now asks for, and plugmem will not mix two models' " +
				"vectors in one index. Nothing is lost, and nothing is read or written " +
				"until the vectors are rebuilt with the new model:\n" +
				`  /${COMMANDS.memoryReembed} — rebuilds every contact's vectors, in place\n` +
				"Or put the previous memory.embedder settings back, and the memories " +
				`answer again as they did. (${message(error)})`,
			error,
		);
	}
	return new MemoryOpenError(
		`memory "${name}" could not be opened: ${message(error)}`,
		error,
	);
}

/** Normalise plugmem's open-interval sentinel to "still true". */
function closedAt(validTo: number): number | undefined {
	return isOpenInterval(validTo) ? undefined : validTo;
}

/** The empty answer, for a contact whose memory has never been written to. */
const NOTHING: MemoryRecallResult = {
	hits: [],
	rendered: "",
	truncated: false,
};

/**
 * One contact's memory, mapped onto the port.
 *
 * `lease` wraps every verb: it serialises against the rest of the workspace and
 * translates a plugmem failure into something the owner can act on. What it does NOT
 * do is hold anything — the reference underneath owns no file and no lock, so this
 * object is safe to keep for the life of the process and safe to hold while another
 * contact is being served.
 */
function contactMemory(
	name: string,
	db: WorkspaceMemory,
	lease: <T>(work: () => Promise<T>) => Promise<T>,
): ContactMemory {
	/** Run one verb: serialised, with plugmem's error translated. */
	const verb = <T>(work: () => Promise<T>): Promise<T> =>
		lease(async () => {
			try {
				return await work();
			} catch (error) {
				throw memoryFailure(name, error);
			}
		});

	/**
	 * A read on a memory that may not exist yet, answered with `empty` if it does not.
	 */
	const read = <T>(work: () => Promise<T>, empty: T): Promise<T> =>
		lease(async () => {
			try {
				return await work();
			} catch (error) {
				if (isMissingDatabase(error)) return empty;
				throw memoryFailure(name, error);
			}
		});

	/**
	 * Attach each similar fact's text.
	 *
	 * The engine returns ids and scores — enough for a program, useless for a model,
	 * which has to be shown the sentence it may be contradicting before it can decide
	 * between revising and keeping both. Called from inside a lease, so these reads go
	 * straight at the reference: routing them back through the queue would deadlock on
	 * the verb that is already holding it.
	 */
	const withText = async (
		similar: { id: number; score: number; reason: string }[],
	): Promise<MemorySimilar[]> => {
		const resolved: MemorySimilar[] = [];
		for (const hint of similar) {
			const snapshot = await db.get(hint.id);
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

	const fact = async (id: number): Promise<MemoryFact | null> => {
		const snapshot = await db.get(id);
		if (!snapshot) return null;
		return {
			id: snapshot.record.id,
			text: snapshot.text,
			tags: await db.tagsOf(id),
			metadata: snapshot.metadata,
			recordedAt: snapshot.record.recordedAt,
			validFrom: snapshot.record.validFrom,
			validTo: closedAt(snapshot.record.validTo),
		};
	};

	return {
		async remember(input): Promise<MemoryWriteOutcome> {
			return verb(async () => {
				const outcome = await db.remember(write(input));
				return { id: outcome.id, similar: await withText(outcome.similar) };
			});
		},

		async rememberMany(inputs): Promise<MemoryWriteOutcome[]> {
			if (inputs.length === 0) return [];
			return verb(async () => {
				const outcomes = await db.rememberMany(inputs.map(write));
				const resolved: MemoryWriteOutcome[] = [];
				for (const outcome of outcomes) {
					resolved.push({
						id: outcome.id,
						similar: await withText(outcome.similar),
					});
				}
				return resolved;
			});
		},

		async rememberGuarded(input): Promise<MemoryGuardedOutcome> {
			return verb(async () => {
				const outcome = await db.rememberGuarded(write(input));
				return {
					status: outcome.status,
					id: outcome.outcome?.id,
					similar: await withText(outcome.similar),
				};
			});
		},

		async revise(id, input): Promise<MemoryWriteOutcome> {
			return verb(async () => {
				const outcome = await db.revise(id, write(input));
				return { id: outcome.id, similar: await withText(outcome.similar) };
			});
		},

		async forget(id): Promise<boolean> {
			return lease(async () => {
				try {
					return await db.forget(id);
				} catch (error) {
					// Nothing to tombstone, whether the fact or the whole memory is what is
					// missing. Both mean the same to a caller asking for it to be gone.
					if (isMissingDatabase(error) || isMissingFact(error)) return false;
					throw memoryFailure(name, error);
				}
			});
		},

		async link(src, relation, dst, provenance): Promise<void> {
			return verb(async () => {
				await db.link({ src, rel: relation, dst, provenance });
			});
		},

		async unlink(src, relation, dst): Promise<boolean> {
			return verb(async () => {
				return db.unlink({ src, rel: relation, dst });
			});
		},

		async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
			return read(async () => {
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
					sources: hit.sources,
					recordedAt: hit.recordedAt,
					validFrom: hit.validFrom,
					validTo: closedAt(hit.validTo),
				}));
				return { hits, rendered: result.rendered, truncated: result.truncated };
			}, NOTHING);
		},

		async get(id): Promise<MemoryFact | null> {
			return read(() => fact(id), null);
		},
	};
}

/**
 * Open the workspace at `root`, creating memories on first write.
 *
 * **One memory verb runs at a time, and that is a wait rather than a failure.** The
 * pool is configured with `maxOpen: 1`, which is how "two people's memories are never
 * open together" stops being a promise — but a pool at its ceiling REFUSES the second
 * caller ("workspace has 1 active databases (the max_open limit); retry after one call
 * finishes"), it does not queue them. And the manager reaches this from two directions
 * at once by design: a turn building its context, and the Telegram polling loop
 * recording an inbound message. Left alone, the second one loses its write — the fact
 * a person just stated — to an error about a limit nobody set.
 *
 * So the ceiling is turned into a queue here. A promise chain makes the verbs run one
 * after another, and the cost is nothing worth counting: a verb is a memory-mapped
 * read or a journal append, and the manager is answering one person at a time anyway.
 *
 * The chain must survive a rejection, or one failed verb wedges every later call.
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
	/** One `ContactMemory` per name, so repeat callers get the same object. */
	const handles = new Map<string, ContactMemory>();

	let queue: Promise<unknown> = Promise.resolve();
	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work, work);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

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
			if (existing) return existing;
			// Nothing is opened here: `memory()` resolves a name into a reference, and the
			// first verb is what touches the file. So a contact nobody has stored anything
			// about costs no file, and a broken configuration is reported by the call that
			// hit it rather than by whichever turn happened to ask first.
			const memory = contactMemory(name, workspace.memory(name), serialized);
			handles.set(name, memory);
			return memory;
		},

		async reembed(onProgress): Promise<MemoryReembedReport[]> {
			// The registry is not the index of what exists: `describe()` is what fills it,
			// and nothing here describes a contact — so `entries()` answers with an empty
			// list however many memories are on disk. The directory is the truth.
			let files: string[];
			try {
				files = await readdir(join(root, DB_SUBDIR));
			} catch {
				// No directory means no memory has ever been written. Nothing to rebuild.
				return [];
			}
			// A memory is a GROUP of files — `u1.plugmem` beside `.plugmem.journal`,
			// `.plugmem.lock` and `.plugmem.snap.N` — and the snapshot is not the one that
			// is always there: it is written at a checkpoint, so a memory written to a
			// moment ago exists on disk as a journal and a lock and nothing else. Matching
			// the snapshot alone would quietly skip exactly the memories that have just
			// been used, and report success. So the name is whatever precedes the suffix,
			// in any of them, deduplicated. (The workspace registry is not in here — it
			// sits beside this directory, not inside it.)
			const names = [
				...new Set(
					files
						.map((file) => file.slice(0, file.indexOf(DB_SUFFIX)))
						.filter((name) => name.length > 0),
				),
			].sort();
			const reports: MemoryReembedReport[] = [];
			for (const [index, name] of names.entries()) {
				await onProgress?.(name, index, names.length);
				const report = await serialized(async () => {
					try {
						return await workspace.memory(name).reembed();
					} catch (error) {
						throw memoryFailure(name, error);
					}
				});
				reports.push({
					name,
					embedded: report.embedded,
					space: report.newSpace,
				});
			}
			return reports;
		},

		closeIdle(): void {
			// Whatever the pool is still holding, released once nothing has used it — which
			// is what hands the file lock back to the owner's own `plugmem-cli`. A memory
			// with a verb in flight is skipped rather than interrupted, so this needs no
			// coordination with the queue above.
			workspace.closeIdle();
		},

		async close(): Promise<void> {
			// After the last verb, not through it: `close()` invalidates every reference,
			// and a verb still queued behind it would fail on a workspace that is gone.
			await serialized(async () => workspace.close());
		},
	};
}
