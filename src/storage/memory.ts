/**
 * The manager's long-term memory, as a port.
 *
 * One interlocutor, one database. Not one file with a section per person — one
 * DATABASE per person, and the name of it is chosen by code from the active chat.
 * That is the whole security property: a fact learned about one contact cannot
 * surface in another's conversation, because while that conversation is running,
 * the other database is not open. The model never names a database; the memory
 * tools have no argument that could name one.
 *
 * What replaced what: this port takes over from the `facts` array that used to live
 * in `contacts/<userId>.json`, capped at twenty entries and evicted by a table of
 * ranks. Three things that cap made impossible, and all three are why this exists:
 * a fact could not be kept without evicting another, the whole list went into the
 * prompt whether or not it had anything to do with the question, and a fact that
 * stopped being true was deleted rather than closed — so "what did I know about
 * them in March" had no answer at all.
 *
 * The engine behind it is plugmem (`memory-plugmem.ts`), and it is the only
 * implementation that ships. This file exists as the seam the rest of the project
 * already uses for every dependency — `TelegramFs`, `ChatStore`, `ContactStore` —
 * so a controller test can run against a fake instead of opening a database per
 * case. It is deliberately free of both the SDK and plugmem.
 */

/**
 * The open end of a validity interval, as it crosses the addon boundary.
 *
 * plugmem stores "still true" as `u64::MAX`, which arrives in JavaScript as a double
 * far past `Number.MAX_SAFE_INTEGER` (~1.8e19 against ~9e15). Comparing it to a
 * timestamp is meaningless, and passing it on as a number invites somebody to format
 * it as a date — so the boundary normalises it to `undefined` and this is the test.
 * No real millisecond timestamp comes anywhere near the safe-integer ceiling.
 */
export function isOpenInterval(validTo: number): boolean {
	return !Number.isSafeInteger(validTo);
}

/**
 * How a durable fact is meant to steer the model, carried as one of its tags.
 *
 *  - `identity`   — who they are (name, role, city): ground answers, address correctly;
 *  - `preference` — likes/dislikes/style/language: adapt tone and format;
 *  - `agreement`  — commitments and promises: honour them, follow up on them;
 *  - `context`    — an ongoing situation: background that may go stale.
 *
 * A tag rather than a field because that is what the engine filters on: "what did we
 * agree" is `tags: ["fact", "agreement"]`, and no code has to know what an agreement is.
 */
export type FactKind = "identity" | "preference" | "agreement" | "context";

export const FACT_KINDS: readonly FactKind[] = [
	"identity",
	"preference",
	"agreement",
	"context",
];

/**
 * Provenance bits returned by plugmem for a recall hit.
 *
 * These are deliberately duplicated as a tiny port-level contract rather than
 * importing the SDK outside `storage/`: a graph or time hit explains why a fact
 * was useful to a prompt, but it is not evidence that a new statement is similar
 * enough to block a write.
 */
export const MEMORY_RECALL_SOURCE = {
	bm25: 1,
	graph: 1 << 1,
	time: 1 << 2,
	vector: 1 << 3,
} as const;

/** What is written when a fact is remembered or revised. */
export interface MemoryWrite {
	text: string;
	/** Subject entity — the contact this is about. Anchors the graph source. */
	entity?: string;
	/** Filters, not phrasing: recall requires ALL requested tags to match. */
	tags?: string[];
	/**
	 * Opaque key→value pointer back at whatever this came from (`chatId`,
	 * `messageId`). The engine stores and returns it verbatim and never searches it.
	 */
	metadata?: Record<string, string>;
	/** When the statement became true, if that is not when we heard it (unix ms). */
	validFrom?: number;
}

/** A stored fact, read back whole. */
export interface MemoryFact {
	id: number;
	text: string;
	tags: string[];
	metadata: Record<string, string>;
	/** When the memory learned it (unix ms). */
	recordedAt: number;
	/** When the statement became true (unix ms). */
	validFrom: number;
	/** When it stopped being true; `undefined` while it still holds. */
	validTo?: number;
}

/**
 * One hit from a recall — and note what is NOT here: the text.
 *
 * The engine returns hits and a rendered block separately, and only the block
 * carries the words. That is not an oversight to work around: the block is the
 * product (it is bounded by the token budget and already formatted for a prompt),
 * while the hits are its provenance. Anything that needs one hit's text asks for it
 * by id.
 */
export interface MemoryHit {
	id: number;
	/** Fused rank across the lexical, graph, temporal and vector sources. */
	score: number;
	/** Bitset of sources that surfaced this hit. */
	sources: number;
	recordedAt: number;
	validFrom: number;
	validTo?: number;
}

export interface MemoryRecallQuery {
	/** Free text. Embedded by the engine when an embedder is configured. */
	query?: string;
	/** A fact must carry every one of these to be considered. */
	tags?: string[];
	/** Anchor entities for the graph source. */
	entities?: string[];
	/** Max hits (0 = the engine's own default). */
	k?: number;
	/**
	 * How much of the prompt a recall may spend, in tokens. This is the cap that
	 * replaced `factsLimit`: the store is unbounded now, and what is bounded is how
	 * much of it may be said in one turn.
	 */
	tokenBudget?: number;
	/** "What was true at" this instant (unix ms) — moves BOTH clocks. */
	asOf?: number;
	/** Window over `recordedAt`, `[from, to)` in unix ms. */
	range?: [number, number];
}

export interface MemoryRecallResult {
	hits: MemoryHit[];
	/**
	 * The prompt-ready block, or `""` when nothing matched. Each line leads with the
	 * fact's id (`- [f3] alice: …`), which is exactly what `forget` and `revise`
	 * take — so a model reading the block can already point at what it wants to
	 * change.
	 */
	rendered: string;
	/** Selection stopped at `k` or at the budget with more left behind. */
	truncated: boolean;
}

/**
 * A live fact the engine thinks a new one may duplicate or contradict.
 *
 * The engine never merges on its own — it surfaces the collision and the caller
 * decides. That is what makes the old "review your whole memory and say what has
 * gone stale" step unnecessary: the conflict arrives at the moment of writing,
 * attached to the fact that caused it.
 */
export interface MemorySimilar {
	id: number;
	/** Resolved by the adapter, because the engine returns only the id. */
	text: string;
	score: number;
	/** What triggered the hint: `"LexicalOverlap"` or `"VectorCosine"`. */
	reason: string;
}

export interface MemoryWriteOutcome {
	id: number;
	similar: MemorySimilar[];
}

/**
 * The memory of ONE contact, already open. There is no database argument on any
 * method here — by the time a caller holds this, the choice has been made.
 */
export interface ContactMemory {
	remember(write: MemoryWrite): Promise<MemoryWriteOutcome>;
	recall(query: MemoryRecallQuery): Promise<MemoryRecallResult>;
	/**
	 * Supersede a fact: close the old interval, record the successor. The old fact
	 * stays answerable through an `asOf` query — which is the difference between a
	 * memory that changed its mind and one that was edited.
	 */
	revise(id: number, write: MemoryWrite): Promise<MemoryWriteOutcome>;
	/** Tombstone a fact. Returns false when there was nothing there. */
	forget(id: number): Promise<boolean>;
	/** One fact, whole — the only way to get a fact's text by id. */
	get(id: number): Promise<MemoryFact | null>;
}

/**
 * The directory of per-contact memories, and the single place a database is chosen.
 */
export interface MemoryWorkspace {
	/**
	 * The memory for one contact, keyed by their Telegram user id. Created on first
	 * write; opening is cheap enough (~2 ms) that this is called per turn rather
	 * than cached by the caller.
	 */
	for(userId: string): Promise<ContactMemory>;
	/**
	 * Close whatever has sat unused past the idle timeout.
	 *
	 * A liveness concern, not a memory one: an open writer holds the database's
	 * exclusive lock, so a bot that never let go would make the owner's own memories
	 * unreachable from `plugmem-cli` for as long as it ran.
	 */
	closeIdle(): void;
	close(): Promise<void>;
}

/**
 * A contact's user id as a database name.
 *
 * plugmem names are `[a-z0-9][a-z0-9_-]*` and — the property this leans on — a name
 * CANNOT represent a path: `..`, a separator and an absolute path are unconstructible
 * rather than filtered, so resolution is a join with nothing to get wrong. Telegram
 * user ids are digits, so the `u` prefix is only there to satisfy the "starts with a
 * letter or digit" rule for every possible id shape and to keep the files legible.
 *
 * Anything that is not a plain id is rejected rather than mangled into something that
 * happens to be valid: a mangled name is a name that could collide with another
 * contact's, and a collision here is one person's facts in another person's chat.
 */
export function memoryDbName(userId: string): string | null {
	return /^[0-9]+$/.test(userId) ? `u${userId}` : null;
}
