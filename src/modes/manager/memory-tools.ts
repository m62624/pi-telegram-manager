/**
 * The tools the model uses on its own memory, and the ledger that keeps a pass using
 * them from running forever.
 *
 * Every write here lands on disk the moment the tool returns. That is not an
 * optimisation, it is the invariant the whole consolidation design rests on: a pass
 * can be pre-empted by a live message at any turn, aborted, or lost to a restart, and
 * whatever it had decided by then must survive. Buffering the results until the pass
 * "finishes" is how the previous design lost a whole interrogation's worth of facts
 * every time somebody wrote mid-pass — the owner's words were "I thought it had
 * already saved fact, fact, fact".
 *
 * The tools take a resolver rather than a database. Which contact's memory is open is
 * a question the controller answers from the active chat, and the model is never
 * given a way to ask a different one: there is no `db` argument on any tool in this
 * file, and there is nothing to put in one.
 */
import { defineTool, type ToolDefinition } from "../../pi/sdk";
import {
	type ContactMemory,
	FACT_KINDS,
	type FactKind,
	MEMORY_TAGS,
	type MemorySimilar,
	type MemoryWrite,
} from "../../storage/memory";
import { FACT_RELATIONS, type FactRelation } from "./decision";

/**
 * Tool names of the memory verbs.
 *
 * The ORDER matters and is not cosmetic: tool schemas are rendered into the head of
 * the prompt, and the same tools in a different order are different bytes — a cache
 * miss on the whole prompt. Fixed here so it cannot drift.
 */
export const MEMORY_TOOL_NAMES = [
	"manager_remember",
	"manager_recall",
	"manager_revise",
	"manager_forget",
	"manager_done",
] as const;

/** The one memory verb that is also available while answering somebody. */
export const MEMORY_REPLY_TOOL_NAME = "manager_remember";

/** Ends a consolidation pass. Nothing else does. */
export const MEMORY_DONE_TOOL_NAME = "manager_done";

/** Maximum inspection-only recall calls before the pass must make a decision. */
export const MAX_RECALLS_WITHOUT_PROGRESS = 3;

/**
 * Authoritative accounting for durable memory operations in one pass.
 *
 * This is kept separate from the compact prompt journal: model-written prose must
 * never turn a refused write into a claimed one.
 */
export interface MemoryOutcome {
	stored?: number;
	duplicates?: number;
	blocked?: number;
	revised?: number;
	forgotten?: number;
}

/** What one memory tool call did, as the ledger records it. */
export interface MemoryStep {
	tool: string;
	/**
	 * A stable signature of the arguments, so "you already ran exactly this" can be
	 * detected. Not shown to anyone — compared.
	 */
	argsKey: string;
	/** One line, for the nudge directive and the owner's log card. */
	summary: string;
	/** Engine outcome, when this step changed or attempted durable memory. */
	outcome?: MemoryOutcome;
}

/**
 * The second queue: what a consolidation pass has done so far.
 *
 * The manager's ordinary accounting asks "did something reach Telegram" — and a
 * memory pass never sends anything to anybody, so that question has no answer for it.
 * This is the parallel book: it counts tool calls, not deliveries, and it is what
 * `turn_end` reads to decide whether the pass continues, gets prodded, or stops.
 */
export class MemoryLedger {
	private readonly entries: MemoryStep[] = [];
	private readonly outcome: Required<MemoryOutcome> = {
		stored: 0,
		duplicates: 0,
		blocked: 0,
		revised: 0,
		forgotten: 0,
	};
	private nudgeCount = 0;
	private done = false;
	private recallsSinceProgress = 0;
	/** Whether the model called ANY memory tool during the turn now ending. */
	private acted = false;
	/**
	 * Whether the LAST completed turn produced nothing, so the next context should
	 * prod rather than repeat the standing instruction.
	 *
	 * Separate from {@link acted}, which is reset for every sample: by the time the
	 * next context is built, "did it act" has already been asked and answered, and
	 * what the directive needs to know is what the answer WAS.
	 */
	private pendingNudge = false;

	/** Called once per sample, before the model's tools can run. */
	startTurn(): void {
		this.acted = false;
	}

	record(step: MemoryStep): void {
		this.entries.push(step);
		for (const key of Object.keys(this.outcome) as (keyof MemoryOutcome)[]) {
			this.outcome[key] += step.outcome?.[key] ?? 0;
		}
		if (step.tool === "manager_recall") {
			this.recallsSinceProgress += 1;
		} else {
			this.recallsSinceProgress = 0;
		}
		this.acted = true;
		this.pendingNudge = false;
	}

	finish(): void {
		this.done = true;
		this.acted = true;
		this.pendingNudge = false;
	}

	/** Did the model call a memory tool this turn? */
	actedThisTurn(): boolean {
		return this.acted;
	}

	/** Did the last completed turn produce nothing? */
	needsNudge(): boolean {
		return this.pendingNudge;
	}

	isFinished(): boolean {
		return this.done;
	}

	steps(): readonly MemoryStep[] {
		return this.entries;
	}

	size(): number {
		return this.entries.length;
	}

	/** Count a turn in which the model called nothing, and return the new total. */
	nudge(): number {
		this.nudgeCount += 1;
		this.pendingNudge = true;
		return this.nudgeCount;
	}

	nudges(): number {
		return this.nudgeCount;
	}

	/** Number of recall calls since the last non-recall memory action. */
	recallCountSinceProgress(): number {
		return this.recallsSinceProgress;
	}

	/** Whether another inspection would only prolong the current pass. */
	recallBlocked(): boolean {
		return this.recallsSinceProgress >= MAX_RECALLS_WITHOUT_PROGRESS;
	}

	/**
	 * The small mutable draft that survives context reconstruction.
	 *
	 * Tool messages are not a reliable state store: the manager context is deliberately
	 * rebuilt from the active chat before every sample. This draft is therefore concise,
	 * explicit and derived only from the pass ledger.
	 */
	contextDraft(): string {
		if (this.entries.length === 0) {
			return (
				"[Memory pass state: no memory tool has run in this pass yet. " +
				"Inspect only what is needed, make useful changes, or call manager_done.]"
			);
		}
		const next = this.recallBlocked()
			? "inspection is complete; choose manager_remember, manager_revise, manager_forget, or manager_done"
			: "decide whether another concrete inspection or a memory action is needed";
		return (
			`[Memory pass state: ${this.recallCountSinceProgress()}/${MAX_RECALLS_WITHOUT_PROGRESS} ` +
			`recall checks since the last memory action; next, ${next}.]`
		);
	}

	/**
	 * Whether the last call repeats the one before it exactly.
	 *
	 * A model that re-runs an identical recall is not thinking, it is stuck — and
	 * because the context is rebuilt byte-identically each sample, nothing in the
	 * prompt would ever tell it so. The directive has to say it out loud.
	 */
	repeatedLast(): boolean {
		const n = this.entries.length;
		if (n < 2) return false;
		const last = this.entries[n - 1];
		const previous = this.entries[n - 2];
		return last.tool === previous.tool && last.argsKey === previous.argsKey;
	}

	/** The journal, for a directive or a log card. Empty string when nothing happened. */
	digest(): string {
		if (this.entries.length === 0) return "";
		return this.entries
			.map((step, index) => `${index + 1}. ${step.summary}`)
			.join("\n");
	}

	/** Return the only completion status the model may rely on. */
	completionSummary(): string {
		const parts: string[] = [];
		const plural = (count: number, word: string): string =>
			`${count} ${word}${count === 1 ? "" : "s"}`;
		if (this.outcome.stored > 0)
			parts.push(`${plural(this.outcome.stored, "fact")} stored`);
		if (this.outcome.revised > 0)
			parts.push(`${plural(this.outcome.revised, "fact")} revised`);
		if (this.outcome.forgotten > 0)
			parts.push(`${plural(this.outcome.forgotten, "fact")} forgotten`);
		if (this.outcome.blocked > 0)
			parts.push(
				`${plural(this.outcome.blocked, "fact")} not stored (similarity review pending)`,
			);
		if (this.outcome.duplicates > 0)
			parts.push(
				`${plural(this.outcome.duplicates, "exact duplicate")} skipped`,
			);
		if (parts.length === 0)
			return "Memory pass finished. No memory changes were committed in this pass.";
		return `Memory pass finished. ${parts.join("; ")}. This status is based on completed memory operations.`;
	}
}

/**
 * What the tools need from the runtime: which memory is open, and who it is about.
 */
export interface MemoryToolContext {
	/**
	 * The memory of the contact this turn is about, or `null` when there is none to
	 * write to — an unidentified chat, or the owner talking to their own bot. Both
	 * are decided in code, by user id, before a tool ever runs.
	 */
	active(): Promise<ContactMemory | null>;
	/** The contact's display name, used as the fact's subject entity. */
	contactName(): string;
	/**
	 * The second queue — resolved per call, not held.
	 *
	 * A pass owns its ledger, and `manager_remember` is also callable while answering
	 * somebody, between passes. Handing the tools one fixed ledger would let a reply
	 * turn's write count against a paused pass's step budget, which is the sort of
	 * bug that shows up as "the memory pass mysteriously ran out of turns".
	 */
	ledger(): MemoryLedger;
	/** Wall clock, injected so tests are not at the mercy of the real one. */
	now(): number;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

function fail(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true as const,
		details: null,
	};
}

function asRelation(value: unknown): FactRelation {
	return FACT_RELATIONS.includes(value as FactRelation)
		? (value as FactRelation)
		: "other";
}

function asKind(value: unknown): FactKind | undefined {
	return FACT_KINDS.includes(value as FactKind)
		? (value as FactKind)
		: undefined;
}

/** Trim a value for a one-line summary. */
function brief(text: string, limit = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * A recalled line's decoration, as the engine renders it: `(2026-08; active)` for a
 * fact that still holds, `(2026-08 → 2026-09; closed)` for one that has been revised.
 */
const RENDERED_INTERVAL =
	/\s*\(\d{4}-\d{2}(?:\s*→\s*\d{4}-\d{2})?;\s*(?:active|closed)\)\s*$/u;

/** The `- [f12] ` a recalled line opens with, when a whole line is pasted back. */
const RENDERED_LEAD = /^\s*-?\s*\[f\d+\]\s*/u;

/**
 * Take the block's formatting back off a statement the model copied out of it.
 *
 * A recall is rendered for reading — `- [f25] Alice: went back to night shifts
 * (2026-08; active) #fact #context` — and every part of that except the sentence is
 * the engine describing the fact, not the fact. A model revising something it just
 * read pastes the line as it saw it, and then the interval is inside the text: it
 * survives the write, renders again beside a fresh one, and the next revision carries
 * two. Observed on a real pass — a corrected sentence arrived with `(2026-08; active)`
 * on the end of it — so this is a fix for something that happens, not a precaution.
 *
 * Only decoration this project can recognise is removed, which is what keeps it from
 * eating a real sentence: a trailing `#tag` goes only when it is one of
 * {@link MEMORY_TAGS} (so "#1 priority" and a hashtag someone actually uses stay), a
 * trailing parenthesis goes only when it carries the `; active` / `; closed` marker
 * (so "works remotely (mostly)" stays), and the leading subject goes only when it is
 * the very name this write is about to be filed under. Repeated because a line already
 * spoiled by an earlier pass carries the interval twice.
 */
export function stripRendering(text: string, entity?: string): string {
	let out = text.trim().replace(RENDERED_LEAD, "");
	const subject = entity?.trim() ? `${entity.trim()}: ` : "";
	if (subject && out.startsWith(subject))
		out = out.slice(subject.length).trim();
	for (;;) {
		const before = out;
		out = out.replace(RENDERED_INTERVAL, "");
		const tag = /\s#([a-z]+)\s*$/u.exec(out);
		if (tag && (MEMORY_TAGS as readonly string[]).includes(tag[1])) {
			out = out.slice(0, tag.index);
		}
		out = out.trim();
		if (out === before.trim()) return out;
	}
}

/** Compare fact statements without treating terminal punctuation as a new fact. */
function factKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.!…]+$/u, "")
		.trim();
}

/**
 * The three answers a write can get, once the engine has judged it.
 *
 * `duplicate` is a strict subset of `blocked`: the engine stopped the write AND one of
 * the facts it stopped it with says the same sentence, so there is nothing for the
 * model to decide.
 */
type WriteVerdict =
	| { kind: "stored"; id: number; similar: MemorySimilar[] }
	| { kind: "duplicate"; existing: MemorySimilar }
	| { kind: "blocked"; similar: MemorySimilar[] };

/**
 * Write a fact unless the memory already holds one close enough to it.
 *
 * **This used to be a `recall`, and that was the bug.** A recall returns the best
 * context it can find for a query — and "best" on a memory with nothing relevant in it
 * is still whatever ranked first. With an embedder configured, every new fact has a
 * nearest vector neighbour by construction, so a recall ALWAYS came back with
 * something, and the tool read anything it came back with as a conflict. The shape of
 * the case that caught it: a note that somebody knows a series well, refused as a
 * near-duplicate of a note that they want to play a game without spoilers, on a fused
 * rank of 0.02 — a number that is not a similarity and has no threshold. The two share
 * a topic and not a statement. Nothing was written, and the answer the tool gave ("Not
 * stored yet — first review these close facts") was indistinguishable from a real
 * collision.
 *
 * `rememberGuarded` asks the question the tool actually meant: the engine compares
 * term sets and cosines against its own thresholds, over the live facts of THIS
 * entity, and stores the fact in the same operation when nothing clears them — so
 * there is no window between the check and the write for a second caller to slip
 * through. A blocked result allocated no id and changed nothing.
 */
async function guardedWrite(
	memory: ContactMemory,
	write: MemoryWrite,
): Promise<WriteVerdict> {
	const outcome = await memory.rememberGuarded(write);
	if (outcome.status === "stored") {
		return { kind: "stored", id: outcome.id as number, similar: [] };
	}
	const key = factKey(write.text);
	const duplicate = outcome.similar.find(
		(candidate) => factKey(candidate.text) === key,
	);
	if (duplicate) return { kind: "duplicate", existing: duplicate };
	return { kind: "blocked", similar: outcome.similar };
}

/**
 * What a confirmed write is told it now sits beside.
 *
 * Only the confirmed path reaches this: an ordinary write that had a collision never
 * became a fact, so there is nothing to report against. Here the model has already
 * read these candidates and answered "both are true" — and the engine surfaces them
 * again on the write itself, which is worth passing on, because the decision it just
 * made is the one it may want to take back, and this carries the ids for doing so.
 */
function conflictNote(
	similar: { id: number; text: string }[],
	newId: number,
): string {
	if (similar.length === 0) return "";
	const lines = similar
		.map((hint) => `  [f${hint.id}] ${hint.text}`)
		.join("\n");
	return (
		`\nThis is close to what you already remember:\n${lines}\n` +
		`If one of those is now WRONG, replace it: manager_revise with its id. ` +
		`If both are true, leave them. If the NEW one was the mistake, ` +
		`manager_forget ${newId}.`
	);
}

/**
 * Build the memory tools. `context` resolves the active contact's database; every
 * tool writes through it immediately and records itself in the ledger.
 */
export function createMemoryTools(
	context: MemoryToolContext,
): ToolDefinition[] {
	/** Resolve the open memory or produce the tool error explaining why there is none. */
	const withMemory = async <T>(
		run: (memory: ContactMemory) => Promise<T>,
	): Promise<T | { error: string }> => {
		const memory = await context.active();
		if (!memory) {
			return {
				error:
					"There is no contact memory open for this conversation, so nothing can " +
					"be stored or looked up. Owner chats deliberately have no personal " +
					"memory; an unidentified chat has no contact either. Do not retry the " +
					"memory tool here. Continue with manager_reply or manager_silent.",
			};
		}
		return run(memory);
	};

	const remember = defineTool({
		name: "manager_remember",
		label: "Manager Remember",
		description:
			"Save a durable or meaningfully useful personal fact to your private long-term memory about the person you are talking to. One fact = one statement: split 'lives in Berlin and prefers voice notes' into two. For EACH fact set subject — 'interlocutor' (about them), 'owner' (about your operator) or 'other' — and kind (identity/preference/agreement/context). ONLY 'interlocutor' facts are stored. Memory follows the contact chat: an Owner-summoned turn inside a contact chat still uses that contact's memory. An explicit Owner instruction in that chat may authorize a fact about the contact; casual Owner remarks do not. The Owner's own direct chat has no contact memory, so do not call this tool there; never file Owner facts under a contact. The memory itself checks each fact against what it already holds about this person, and only stops a write when a stored fact genuinely says nearly the same thing; a merely related fact is stored without asking. Read the result as a decision: 'Stored [fN]' means committed; 'Already remembered [fN]' means exact duplicate and no write; 'Not stored yet' means no write and requires review. If the new fact replaces a listed fact, use manager_revise with its [fN] id. If both statements are true, retry manager_remember with confirm_similar=true to write the new fact. Never use confirm_similar to override a real contradiction. A personal interest, future intention, recurring activity or spoiler/style preference is worth remembering even when the subject is time-bound — for example, 'wants to pursue a hobby without unwanted details'. Do not save the topic of a conversation by itself, a passing mood, today's location, or a one-off detail with no future use.",
		parameters: {
			type: "object",
			properties: {
				facts: {
					type: "array",
					items: {
						type: "object",
						properties: {
							text: { type: "string", description: "One short durable fact." },
							subject: {
								type: "string",
								enum: FACT_RELATIONS,
								description:
									"Who it is about: 'interlocutor' (stored), 'owner' or 'other' (dropped).",
							},
							kind: {
								type: "string",
								enum: FACT_KINDS,
								description:
									"identity (who they are) | preference (tastes/style) | agreement (commitments) | context (ongoing situation).",
							},
						},
						required: ["text", "subject"],
						additionalProperties: false,
					},
					description: "Durable facts, each tagged with subject and kind.",
				},
				confirm_similar: {
					type: "boolean",
					description:
						"Only after manager_remember answered 'Not stored yet' and you decided both statements are true; allows this new fact to be committed alongside the one it is close to.",
				},
			},
			required: ["facts"],
			additionalProperties: false,
		} as never,
		async execute(
			_id,
			params: {
				facts?: Array<{ text?: string; subject?: string; kind?: string }>;
				confirm_similar?: boolean;
			},
		) {
			const raw = Array.isArray(params.facts) ? params.facts : [];
			// The who-is-who firewall, and with one database per person it is a security
			// boundary rather than tidiness: a fact about the OWNER filed here would be a
			// fact about the owner surfacing in a stranger's conversation.
			const keep = raw
				.filter((item) => item?.text?.trim())
				.map((item) => ({
					text: stripRendering(item.text as string, context.contactName()),
					subject: asRelation(item.subject),
					kind: asKind(item.kind) ?? "context",
				}))
				.filter(
					(fact) => fact.subject === "interlocutor" && fact.text.length > 0,
				);
			if (keep.length === 0) {
				context.ledger().record({
					tool: "manager_remember",
					argsKey: "none",
					summary: "stored 0 facts (no interlocutor facts)",
				});
				return ok(
					"Nothing stored: owner/other facts are deliberately discarded. This " +
						"tool stores only durable facts about an interlocutor in that person's " +
						"contact memory. In a contact chat, retry only with facts about the " +
						"interlocutor; in the Owner's own chat, do not retry the memory tool.",
				);
			}
			let stored = 0;
			let blocked = 0;
			let duplicates = 0;
			const result = await withMemory(async (memory) => {
				const notes: string[] = [];
				for (const fact of keep) {
					const write: MemoryWrite = {
						text: fact.text,
						// The subject entity, and also what scopes the similarity check: the
						// engine compares a new fact against this entity's live facts, not
						// against everything in the file.
						entity: context.contactName(),
						tags: ["fact", fact.kind],
						validFrom: context.now(),
					};
					const verdict = await guardedWrite(memory, write);
					if (verdict.kind === "duplicate") {
						duplicates += 1;
						notes.push(
							`Already remembered [f${verdict.existing.id}]: ${verdict.existing.text}. Nothing new was written.`,
						);
						continue;
					}
					if (verdict.kind === "blocked" && !params.confirm_similar) {
						blocked += 1;
						notes.push(
							`Not stored yet — first review these close facts:\n${verdict.similar
								.map((similar) => `  [f${similar.id}] ${similar.text}`)
								.join("\n")}\n` +
								"Decision required: if the new statement replaces one, use manager_revise with that [fN] id; if both are true, retry manager_remember with confirm_similar=true. No new fact was written in this call.",
						);
						continue;
					}
					if (verdict.kind === "stored") {
						stored += 1;
						notes.push(`Stored [f${verdict.id}] ${fact.text}`);
						continue;
					}
					// Confirmed: the model has read the close facts and decided both are true,
					// so the guard is spent and the plain write commits. Its own `similar`
					// hints are the same candidates it just reviewed, named again with the ids
					// it would need to change its mind.
					const outcome = await memory.remember(write);
					stored += 1;
					notes.push(
						`Stored [f${outcome.id}] ${fact.text}${conflictNote(
							outcome.similar,
							outcome.id,
						)}`,
					);
				}
				if (blocked > 0 && stored === 0) {
					notes.unshift(
						"The memory already holds facts close enough to these that nothing was committed, until you decide whether this is a revision or a compatible additional fact.",
					);
				}
				return notes.join("\n");
			});
			if (typeof result !== "string") return fail(result.error);
			context.ledger().record({
				tool: "manager_remember",
				argsKey: keep.map((fact) => fact.text).join("|"),
				summary: `stored ${stored} fact(s); ${blocked} held for review; ${duplicates} duplicate(s) skipped`,
				outcome: { stored, blocked, duplicates },
			});
			return ok(result);
		},
	});

	const recall = defineTool({
		name: "manager_recall",
		label: "Manager Recall",
		description:
			"Search your own long-term memory about this person for one concrete unresolved point. Use it to inspect what a conversation may have made obsolete or to answer a question from memory rather than guessing. Do NOT use it to check before writing: manager_remember refuses on its own to write a fact the memory already holds. Always give a query in words — that is what the search ranks on. Tags only NARROW that search and every one you add must be on the fact, so 'fact'+'preference' cannot return an identity or a context fact and an empty answer means only that nothing carries all of them: prefer no tags, or one. Do not repeat recall with rephrased queries when the answer is already available. Returns a ranked block; each line starts with the fact's id in [fN], which manager_revise and manager_forget take.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"What you are looking for, in words — e.g. 'where they work' or 'what we agreed about the deadline'. This is what the search ranks on; without it there is nothing to rank.",
				},
				tags: {
					type: "array",
					items: { type: "string", enum: MEMORY_TAGS },
					description:
						"Optional filter, ANDed: a memory must carry EVERY tag listed, so each one you add can only remove answers. Leave it out unless one kind is genuinely all you want. 'fact' = durable facts, narrowed by identity/preference/agreement/context; 'episode' = what happened, narrowed by message (they said it), owner (the owner said it) or turn+reply/silent (what you did).",
				},
			},
			additionalProperties: false,
		} as never,
		async execute(_id, params: { query?: string; tags?: string[] }) {
			const ledger = context.ledger();
			if (ledger.recallBlocked()) {
				return fail(
					"Recall is paused for this memory pass: several inspections produced no " +
						"memory action. Do not search again with a rephrased query. Choose " +
						"manager_remember, manager_revise, manager_forget, or manager_done.",
				);
			}
			const query = params.query?.trim() || undefined;
			const tags = Array.isArray(params.tags)
				? params.tags.filter((tag) => typeof tag === "string" && tag.trim())
				: undefined;
			// Tags are AND filters over a closed vocabulary, so one the memory has never
			// written matches nothing — and an empty answer would read as "there is
			// nothing about them", which is a different and much worse claim.
			const unknown = tags?.filter(
				(tag) => !(MEMORY_TAGS as readonly string[]).includes(tag),
			);
			if (unknown && unknown.length > 0) {
				return fail(
					`No memory is tagged ${unknown.join(" or ")}, and a memory must carry ` +
						"every tag you ask for — so this search would match nothing whatever " +
						`is stored. The tags in use are: ${MEMORY_TAGS.join(", ")}. Search ` +
						"again with one of those, or with no tags at all.",
				);
			}
			const result = await withMemory(async (memory) =>
				memory.recall({ query, tags, entities: [context.contactName()] }),
			);
			if ("error" in result) return fail(result.error);
			context.ledger().record({
				tool: "manager_recall",
				argsKey: `${query ?? ""}#${(tags ?? []).join(",")}`,
				summary: `recalled ${brief(query ?? tags?.join(", ") ?? "everything", 40)} → ${
					result.hits.length
				} hit(s)`,
			});
			return ok(
				result.rendered.trim() ||
					"Nothing in memory matches that. It is not there — do not infer it from the conversation.",
			);
		},
	});

	const revise = defineTool({
		name: "manager_revise",
		label: "Manager Revise",
		description:
			"Replace a fact that has stopped being true with what is true now — they changed job, moved, cancelled the plan. Give the id from its [fN] tag and the corrected statement. Write the statement alone: the '(2026-08; active)' after a recalled line and the '#tags' at its end are how the memory displays a fact, not part of it, and copying them in stores them as text. One fact = one statement — do not merge several updates into one line; revise them one at a time, and drop what is no longer true instead of carrying it along. The old version is closed rather than erased, so the memory still knows what it used to believe and when. Prefer this over forget whenever there is a successor: forget is for a fact that was simply wrong.",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "number",
					description: "The number in the fact's [fN] tag.",
				},
				text: { type: "string", description: "What is true now." },
				kind: {
					type: "string",
					enum: FACT_KINDS,
					description: "identity | preference | agreement | context.",
				},
			},
			required: ["id", "text"],
			additionalProperties: false,
		} as never,
		async execute(_id, params: { id?: number; text?: string; kind?: string }) {
			const target = params.id;
			// The line being replaced is one the model has just READ, so the correction
			// tends to arrive wearing the block's formatting — see `stripRendering`.
			const text = params.text
				? stripRendering(params.text, context.contactName())
				: "";
			if (!Number.isFinite(target))
				return fail("manager_revise needs a fact id.");
			if (!text) return fail("manager_revise needs the corrected text.");
			const kind = asKind(params.kind) ?? "context";
			const result = await withMemory(async (memory) => {
				const before = await memory.get(target as number);
				if (!before) return { missing: true as const };
				const outcome = await memory.revise(target as number, {
					text,
					entity: context.contactName(),
					tags: ["fact", kind],
					validFrom: context.now(),
				});
				return { missing: false as const, before: before.text, id: outcome.id };
			});
			if ("error" in result) return fail(result.error);
			if (result.missing) {
				return fail(
					`There is no fact [f${target}] to revise. Run manager_recall to see what ids exist.`,
				);
			}
			context.ledger().record({
				tool: "manager_revise",
				argsKey: `${target}#${text}`,
				summary: `revised [f${target}] "${brief(result.before, 40)}" → "${brief(text, 40)}"`,
				outcome: { revised: 1 },
			});
			return ok(
				`Replaced [f${target}] with [f${result.id}]: ${text}\nThe old version is closed, not erased.`,
			);
		},
	});

	const forget = defineTool({
		name: "manager_forget",
		label: "Manager Forget",
		description:
			"Drop a fact you should not be carrying: it was wrong, it was never about this person, or it is stale with no successor. Give the id from its [fN] tag. If there IS a successor — the thing changed rather than being false — use manager_revise instead, so the memory keeps what it used to believe.",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "number",
					description: "The number in the fact's [fN] tag.",
				},
				reason: {
					type: "string",
					description: "Short reason, for the owner's log.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		} as never,
		async execute(_id, params: { id?: number; reason?: string }) {
			const target = params.id;
			if (!Number.isFinite(target))
				return fail("manager_forget needs a fact id.");
			const result = await withMemory(async (memory) => {
				const before = await memory.get(target as number);
				if (!before) return { gone: true as const };
				await memory.forget(target as number);
				return { gone: false as const, text: before.text };
			});
			if ("error" in result) return fail(result.error);
			if (result.gone) {
				return fail(
					`There is no fact [f${target}] to forget. Run manager_recall to see what ids exist.`,
				);
			}
			const reason = params.reason?.trim();
			context.ledger().record({
				tool: "manager_forget",
				argsKey: String(target),
				summary: `forgot [f${target}] "${brief(result.text, 40)}"${
					reason ? ` — ${brief(reason, 40)}` : ""
				}`,
				outcome: { forgotten: 1 },
			});
			return ok(`Forgotten [f${target}]: ${result.text}`);
		},
	});

	const done = defineTool({
		name: MEMORY_DONE_TOOL_NAME,
		label: "Manager Done",
		description:
			"End the memory pass. Call this when the memory matches the conversation — everything durable is stored, nothing stale is left standing — or when there was nothing worth changing at all. The returned completion status is authoritative and is calculated from completed memory operations; do not claim a fact was stored when manager_remember said 'Not stored yet' or 'Already remembered'. This is the ONLY way a memory pass ends; nothing is sent to anyone either way.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as never,
		async execute(_id, _params: unknown) {
			const completion = context.ledger().completionSummary();
			context.ledger().finish();
			return ok(completion);
		},
	});

	return [remember, recall, revise, forget, done];
}
