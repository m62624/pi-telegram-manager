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
	MemoryRecallQuery,
	MemoryRecallResult,
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

/** One contact's fake memory, with the stored facts exposed for assertions. */
export class FakeContactMemory implements ContactMemory {
	readonly facts: MemoryFact[] = [];
	private nextId = 0;

	async remember(write: MemoryWrite): Promise<MemoryWriteOutcome> {
		const id = this.nextId++;
		const now = write.validFrom ?? 0;
		// Same shape of hint the engine gives: anything sharing a word, so a test can
		// exercise the conflict path without pretending to be BM25.
		const similar = this.live()
			.filter((fact) => {
				const overlap = [...words(fact.text)].filter((word) =>
					words(write.text).has(word),
				);
				return overlap.length > 0;
			})
			.map((fact) => ({
				id: fact.id,
				text: fact.text,
				score: 1,
				reason: "LexicalOverlap",
			}));
		this.facts.push({
			id,
			text: write.text,
			tags: write.tags ?? [],
			metadata: write.metadata ?? {},
			recordedAt: now,
			validFrom: now,
		});
		return { id, similar };
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
		const matched = this.live()
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
	private live(): MemoryFact[] {
		return this.facts.filter((fact) => fact.validTo === undefined);
	}

	/** Just the text of the live facts, for readable assertions. */
	texts(): string[] {
		return this.live().map((fact) => fact.text);
	}
}

/** A workspace of fake memories, one per user id. */
export class FakeMemoryWorkspace implements MemoryWorkspace {
	readonly databases = new Map<string, FakeContactMemory>();
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

	closeIdle(): void {
		this.closedIdle += 1;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
