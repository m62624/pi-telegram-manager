/**
 * An in-memory {@link MemoryWorkspace} for tests that are about something else.
 *
 * It is a stand-in, not a reimplementation: recall matches on shared words and orders
 * by recency, which is enough for "did the block reach the prompt", "did the write go
 * to the right contact" and "does the pass see what it stored". Anything that is
 * actually about retrieval — ranking, budgets, bitemporal answers — is tested against
 * the real engine in `tests/storage/memory-plugmem.test.ts`.
 *
 * The one behaviour it copies exactly is isolation: a database per user id, and no way
 * to reach one from another. A fake that let facts leak would let the tests pass while
 * the property they exist to protect was broken.
 */
import type {
	ContactMemory,
	MemoryFact,
	MemoryGuardedOutcome,
	MemoryRecallQuery,
	MemoryRecallResult,
	MemoryReembedReport,
	MemorySimilar,
	MemoryWorkspace,
	MemoryWrite,
	MemoryWriteOutcome,
} from "../../src/storage/memory";

function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 2),
	);
}

/**
 * plugmem's lexical threshold, copied because the number is the behaviour.
 *
 * The engine blocks a guarded write when the term-set Jaccard of two facts is ABOVE
 * `similar_jaccard`, which defaults to 0.5 — so "works at a bank" against "works at a
 * bank in town" is 2/3 and stops, while two facts sharing one word out of nine do not.
 * A fake that blocked on any shared word would be the very bug these tests exist to
 * catch.
 */
const SIMILAR_JACCARD = 0.5;

/** Term-set overlap of two statements, on the same scale plugmem measures it. */
function jaccard(left: string, right: string): number {
	const a = words(left);
	const b = words(right);
	if (a.size === 0 || b.size === 0) return 0;
	let both = 0;
	for (const word of a) if (b.has(word)) both += 1;
	return both / (a.size + b.size - both);
}

/** The engine's `SIMILAR_CANDIDATE_CAP`: how far back a guarded write looks. */
const SIMILAR_CANDIDATE_CAP = 32;

/** A stored fact plus the subject it was filed under, which the port does not read back. */
interface FakeFact extends MemoryFact {
	entity?: string;
}

/** One contact's fake memory, with the stored facts exposed for assertions. */
export class FakeContactMemory implements ContactMemory {
	readonly facts: FakeFact[] = [];
	/** Edges written, rendered the way a recall shows them. */
	readonly links: string[] = [];
	private nextId = 0;

	/**
	 * What the next write is RECORDED at, when a test is about the knowledge axis.
	 *
	 * The engine stamps this itself, from the wall clock, and it is NOT `validFrom`:
	 * one says when the memory learned something, the other when the statement became
	 * true, and `range` reads the first while `asOf` moves both. A fake with no clock
	 * has to conflate them by default — set this to test anything that turns on the
	 * difference, and note that a test which sets only `validFrom` is asking a question
	 * the real engine would answer differently.
	 */
	recordingAt: number | null = null;

	async remember(write: MemoryWrite): Promise<MemoryWriteOutcome> {
		const similar = this.similarTo(write.text, write.entity);
		const id = this.nextId++;
		const recordedAt = this.recordingAt ?? write.validFrom ?? 0;
		this.facts.push({
			id,
			text: write.text,
			entity: write.entity,
			tags: write.tags ?? [],
			metadata: write.metadata ?? {},
			recordedAt,
			validFrom: write.validFrom ?? recordedAt,
		});
		return { id, similar };
	}

	/**
	 * The write that refuses to duplicate — the engine's own two-in-one operation.
	 *
	 * Scoped to the subject entity, and that is not a detail this fake may round off.
	 * It used to compare against every fact in the database, on the reasoning that one
	 * fake memory is one contact's anyway — which read as harmless and was not: the
	 * engine compares a write only against the entity it names, so a database whose
	 * entities are mixed behaves nothing like the fake. That gap is exactly the one
	 * that let episodes be filed under the contact and hid what it did to the guard
	 * (see `MEMORY_EPISODE_ENTITY`). The 32-candidate ceiling is copied for the same
	 * reason — it is what made a duplicate stop being seen at all.
	 */
	async rememberGuarded(write: MemoryWrite): Promise<MemoryGuardedOutcome> {
		const similar = this.similarTo(write.text, write.entity);
		if (similar.length > 0) return { status: "blocked", similar };
		const { id } = await this.remember(write);
		return { status: "stored", id, similar: [] };
	}

	/**
	 * Live facts of the same subject close enough to `text` to say the same thing.
	 *
	 * `SIMILAR_CANDIDATE_CAP` in the engine: the entity's most recent facts and no
	 * more, so a subject that accumulates entries loses sight of its older ones.
	 */
	private similarTo(text: string, entity?: string): MemorySimilar[] {
		return this.live()
			.filter((fact) => fact.entity === entity)
			.slice(-SIMILAR_CANDIDATE_CAP)
			.map((fact) => ({ fact, score: jaccard(fact.text, text) }))
			.filter(({ score }) => score > SIMILAR_JACCARD)
			.map(({ fact, score }) => ({
				id: fact.id,
				text: fact.text,
				score,
				reason: "LexicalOverlap",
			}));
	}

	async rememberMany(writes: MemoryWrite[]): Promise<MemoryWriteOutcome[]> {
		const outcomes: MemoryWriteOutcome[] = [];
		for (const write of writes) outcomes.push(await this.remember(write));
		return outcomes;
	}

	async link(
		src: string,
		relation: string,
		dst: string,
		_provenance?: number,
	): Promise<void> {
		const edge = `${src} —${relation}→ ${dst}`;
		if (!this.links.includes(edge)) this.links.push(edge);
	}

	/** Close an edge, reporting whether one was open — mirrors the real engine. */
	async unlink(src: string, relation: string, dst: string): Promise<boolean> {
		const edge = `${src} —${relation}→ ${dst}`;
		const index = this.links.indexOf(edge);
		if (index < 0) return false;
		this.links.splice(index, 1);
		return true;
	}

	async revise(id: number, write: MemoryWrite): Promise<MemoryWriteOutcome> {
		const previous = this.facts.find((fact) => fact.id === id);
		if (previous) previous.validTo = write.validFrom ?? 0;
		return this.remember(write);
	}

	async forget(id: number): Promise<boolean> {
		const index = this.facts.findIndex((fact) => fact.id === id);
		if (index < 0) return false;
		this.facts.splice(index, 1);
		return true;
	}

	async get(id: number): Promise<MemoryFact | null> {
		return this.facts.find((fact) => fact.id === id) ?? null;
	}

	async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
		const needle = words(query.query ?? "");
		const matched = this.asOf(query.asOf)
			// `[from, to)` over the knowledge axis — when the memory learned it.
			//
			// Applied as a filter, which is NOT what the engine does: there `range` is one
			// of the four retrieval sources, so a windowed recall that also carries a
			// query or an entity anchor comes back with the window PLUS whatever those
			// matched. The caller is expected to send a window on its own, and then the
			// two behave alike; `manager_recall` is what makes sure of it.
			.filter(
				(fact) =>
					query.range === undefined ||
					(fact.recordedAt >= query.range[0] &&
						fact.recordedAt < query.range[1]),
			)
			.filter((fact) =>
				(query.tags ?? []).every((tag) => fact.tags.includes(tag)),
			)
			.filter(
				(fact) =>
					needle.size === 0 ||
					[...words(fact.text)].some((word) => needle.has(word)),
			)
			.sort((a, b) => b.recordedAt - a.recordedAt);
		const hits = matched.map((fact) => ({
			id: fact.id,
			score: 1,
			// The lexical bit, as plugmem sets it. Nothing reads it — it is provenance
			// the port carries through — but a hit with no source at all would be a
			// shape the engine never produces.
			sources: 1,
			recordedAt: fact.recordedAt,
			validFrom: fact.validFrom,
			validTo: fact.validTo,
		}));
		const rendered =
			matched.length === 0
				? ""
				: `## memory\n${matched
						.map(
							(fact) =>
								`- [f${fact.id}] ${fact.text}${fact.tags
									.map((tag) => ` #${tag}`)
									.join("")}`,
						)
						.join("\n")}\n`;
		return { hits, rendered, truncated: false };
	}

	/** Facts whose interval is still open — what a plain recall may return. */
	private live(): FakeFact[] {
		return this.facts.filter((fact) => fact.validTo === undefined);
	}

	/**
	 * The facts as the memory held them at `at`, or the live ones when it is unset.
	 *
	 * Both clocks move together, which is the part worth copying: a fact recorded
	 * AFTER the instant asked about does not answer, however true it is now. Anything
	 * else would let an `as_of` question be answered with today's knowledge.
	 */
	private asOf(at?: number): FakeFact[] {
		if (at === undefined) return this.live();
		return this.facts.filter(
			(fact) =>
				fact.recordedAt <= at &&
				fact.validFrom <= at &&
				(fact.validTo === undefined || fact.validTo > at),
		);
	}

	/** Just the text of the live facts, for readable assertions. */
	texts(): string[] {
		return this.live().map((fact) => fact.text);
	}
}

/** A workspace of fake memories, one per user id. */
export class FakeMemoryWorkspace implements MemoryWorkspace {
	readonly databases = new Map<string, FakeContactMemory>();
	readonly reembedded: string[] = [];
	closedIdle = 0;
	closed = false;

	async for(userId: string): Promise<ContactMemory> {
		return this.of(userId);
	}

	/** The memory of one contact, created on demand — typed, for assertions. */
	of(userId: string): FakeContactMemory {
		const existing = this.databases.get(userId);
		if (existing) return existing;
		const created = new FakeContactMemory();
		this.databases.set(userId, created);
		return created;
	}

	/** What one contact's memory holds, or [] when they have none. */
	texts(userId: string): string[] {
		return this.databases.get(userId)?.texts() ?? [];
	}

	async reembed(
		onProgress?: (
			name: string,
			index: number,
			total: number,
		) => void | Promise<void>,
	): Promise<MemoryReembedReport[]> {
		const names = [...this.databases.keys()].sort();
		const reports: MemoryReembedReport[] = [];
		for (const [index, name] of names.entries()) {
			await onProgress?.(name, index, names.length);
			this.reembedded.push(name);
			reports.push({
				name,
				embedded: this.databases.get(name)?.texts().length ?? 0,
				space: "fake-embedder",
			});
		}
		return reports;
	}

	closeIdle(): void {
		this.closedIdle += 1;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
