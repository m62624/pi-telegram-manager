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
 * Every tag this project writes — the whole vocabulary, and it is closed.
 *
 * plugmem can list the tags a memory actually holds, and for a store whose tags come
 * from its users that would be the only honest way to know them. Here nothing outside
 * this codebase ever writes one: the model picks a `kind` from {@link FACT_KINDS} and
 * code turns it into tags, episodes are tagged by the controller from a fixed set, and
 * the legacy import adds `migrated`. So the catalogue is knowable without asking, and
 * this is it:
 *
 *  - `fact` + one of {@link FACT_KINDS} — a durable statement (`memory-tools.ts`);
 *  - `migrated` — a fact moved out of the pre-plugmem `contacts/*.json`;
 *  - `episode` + `message` — something they said, as they said it;
 *  - `episode` + `owner` — something the owner said in their chat;
 *  - `episode` + `turn` + `reply`/`silent` — what the manager did about it.
 *
 * It matters that this is a LIST rather than a free string on the recall tool: tags
 * are AND filters, so one invented tag returns nothing at all — and "nothing matched"
 * and "that tag does not exist" read identically to a model that then concludes it
 * knows nothing about the person.
 */
export const MEMORY_TAGS = [
	"fact",
	"identity",
	"preference",
	"agreement",
	"context",
	"migrated",
	"episode",
	"message",
	"owner",
	"turn",
	"reply",
	"silent",
] as const;

/**
 * The subject episodes are filed under — never the contact themselves.
 *
 * Facts and episodes go into the same database, because they are about the same
 * person; what they must NOT share is the subject entity, and that is not a matter of
 * tidiness. The engine's duplicate detector is scoped to the entity a write names and
 * compares against its 32 most recent facts — so with episodes on the contact, a chat
 * of ordinary length is enough for the window to hold nothing but messages. Two things
 * break at once, and both were measured against the real engine:
 *
 *  - a durable fact drawn from what somebody just said is refused as a near-duplicate
 *    OF THEIR OWN MESSAGE (a paraphrase scores 0.625 against it lexically, and higher
 *    still through a vector), and the model is told to revise or confirm against an
 *    episode it should never be editing;
 *  - a fact the memory really does already hold is no longer seen at all, because the
 *    32 most recent entries under that entity are messages — so `telegram_manager_remember`
 *    stops catching duplicates, which is the whole reason the guard exists.
 *
 * A constant rather than a name derived from the contact: it is the same subject for
 * the life of the database, so it survives a Telegram rename, and one database is one
 * person anyway — there is nobody here to confuse it with. Episodes stay reachable
 * from the contact through {@link MEMORY_EPISODE_RELATION}, one graph hop away.
 */
export const MEMORY_EPISODE_ENTITY = "chat log";

/** The edge that leads from the contact to their episodes. */
export const MEMORY_EPISODE_RELATION = "said";

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
	/**
	 * Fused rank across the lexical, graph, temporal and vector sources.
	 *
	 * A ranking number and nothing else. It is not a cosine, it is not a similarity,
	 * and it has no threshold below which a hit stops meaning anything — retrieval
	 * returns the best it has, which on a thin match is still something. Deciding
	 * whether two statements say the same thing is {@link ContactMemory.rememberGuarded}.
	 */
	score: number;
	/** Bitset of the sources that surfaced this hit, verbatim from the engine. */
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
 * What a guarded write did — the engine's own answer to "is this already known?".
 *
 * The distinction this type exists to keep is the one that cost a whole fact: a
 * RECALL returns the best context it can find and will hand back a weak nearest
 * neighbour when there is nothing good, while the similarity DETECTOR compares term
 * sets and cosines against fixed thresholds (`similar_jaccard`, `similar_cos`) and
 * answers with nothing at all when nothing is close. Treating the first as the second
 * is what refused "knows a series well" as a near-duplicate of "wants to play a game
 * without spoilers": one shared vector neighbour, fused score 0.02, no similarity
 * whatsoever.
 *
 * `blocked` means nothing was written and no id was allocated — the check and the
 * conditional write are one operation inside the engine, so nothing can slip between
 * them.
 */
export interface MemoryGuardedOutcome {
	status: "stored" | "blocked";
	/** The new fact's id. Absent when blocked, because none was allocated. */
	id?: number;
	/** What stopped it, above the engine's thresholds. Empty when stored. */
	similar: MemorySimilar[];
}

/** What one memory's vector axis replacement did. */
export interface MemoryReembedReport {
	/** The contact database, as {@link memoryDbName} spells it. */
	name: string;
	/** Facts recomputed with the configured embedder. */
	embedded: number;
	/** The vector-space identity this memory now carries. */
	space: string;
}

/**
 * The memory of ONE contact, already open. There is no database argument on any
 * method here — by the time a caller holds this, the choice has been made.
 */
export interface ContactMemory {
	remember(write: MemoryWrite): Promise<MemoryWriteOutcome>;
	/**
	 * Store a batch as one operation, in order, with an outcome each.
	 *
	 * For facts that arrive together and are already decided — the legacy import is the
	 * case that exists. It is not a faster `remember` loop to reach for by default: a
	 * batch is one journal append, so either all of it is durable or none of it is, and
	 * the whole design elsewhere leans the other way, on each write landing the moment
	 * its tool returns. Unguarded, like `remember`.
	 */
	rememberMany(writes: MemoryWrite[]): Promise<MemoryWriteOutcome[]>;
	/**
	 * Write only if the engine's similarity detector finds nothing close enough.
	 *
	 * This is what a caller wanting "do not create a duplicate" must use. The check is
	 * scoped to the fact's own `entity` and bounded by that entity's most recent facts,
	 * and it is the same code path `remember` reports its `similar` hints from — the
	 * difference being that here the answer arrives BEFORE a fact exists.
	 */
	rememberGuarded(write: MemoryWrite): Promise<MemoryGuardedOutcome>;
	recall(query: MemoryRecallQuery): Promise<MemoryRecallResult>;
	/**
	 * Supersede a fact: close the old interval, record the successor. The old fact
	 * stays answerable through an `asOf` query — which is the difference between a
	 * memory that changed its mind and one that was edited.
	 */
	revise(id: number, write: MemoryWrite): Promise<MemoryWriteOutcome>;
	/** Tombstone a fact. Returns false when there was nothing there. */
	forget(id: number): Promise<boolean>;
	/**
	 * Join two subjects with a typed edge, creating it or refreshing it.
	 *
	 * The original use is {@link MEMORY_EPISODE_ENTITY}: a recall anchored on the
	 * contact walks their edges, so the link is what keeps their messages reachable
	 * from their name once the episodes stopped being filed under it. The topic graph
	 * (`telegram_manager_link`) is the second: `provenance`, when given, is the fact id the edge
	 * follows from — the answer to "why does the memory think this edge exists", surfaced
	 * back by a graph recall.
	 */
	link(
		src: string,
		relation: string,
		dst: string,
		provenance?: number,
	): Promise<void>;
	/**
	 * Close a typed edge for current recall, without touching any fact.
	 *
	 * The edge is not deleted: its interval closes the way a revised fact's does, so
	 * `asOf` before the unlink still walks the graph as it stood. Resolves with whether
	 * an edge was actually open — a caller that unlinks something never linked is told
	 * plainly, rather than getting a silent no-op.
	 */
	unlink(src: string, relation: string, dst: string): Promise<boolean>;
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
	 * Recompute every stored fact's vector with the configured embedder, one contact
	 * at a time, and report what each memory did.
	 *
	 * The owner's operation, never an automatic one. Two settings changes need it, and
	 * they fail differently:
	 *
	 *  - **turning an embedder on** over memories built without one: nothing breaks,
	 *    and that is the trap. New facts get vectors, the facts learned before the
	 *    change stay lexical-only, and the memory answers semantic questions about
	 *    half of what it knows without ever saying so;
	 *  - **changing the model** (or its `space_id`): every read and every write fails
	 *    with a vector-space mismatch until this has run, because mixing two models'
	 *    vectors in one index would silently return nonsense instead.
	 *
	 * `onProgress` is called before each memory and awaited, since this calls the
	 * provider once per batch of facts and the owner is watching something — a
	 * terminal, or a chat where two unawaited sends arrive in whichever order.
	 */
	reembed(
		onProgress?: (
			name: string,
			index: number,
			total: number,
		) => void | Promise<void>,
	): Promise<MemoryReembedReport[]>;
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
