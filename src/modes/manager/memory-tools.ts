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
	private nudgeCount = 0;
	private done = false;
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
 * How a conflicting fact is reported back to the model.
 *
 * The engine surfaces collisions on write and refuses to resolve them, which is the
 * behaviour this whole design wanted: the model is told, at the moment it writes,
 * that something it already knows says nearly the same thing — with the id it would
 * need to revise it. Previously this took a whole extra inference (a step that read
 * the entire memory back and asked "what has gone stale"), and it only ran during a
 * consolidation pass.
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
					"memory; do not retry the memory tool. Continue with manager_reply or " +
					"manager_silent.",
			};
		}
		return run(memory);
	};

	const remember = defineTool({
		name: "manager_remember",
		label: "Manager Remember",
		description:
			"Save a durable fact to your private long-term memory about the person you are talking to. One fact = one statement: split 'lives in Berlin and prefers voice notes' into two. For EACH fact set subject — 'interlocutor' (about them), 'owner' (about your operator) or 'other' — and kind (identity/preference/agreement/context). ONLY 'interlocutor' facts are stored. Owner-summoned turns have no contact memory: do not call this tool for the Owner or the Owner's own chat. Save what will still be true next month (name, city, role, preferences, commitments), not a passing mood, today's location, or anything the conversation above already says. If a fact is close to one you already hold, you will be told so along with its id, so you can replace it.",
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
			},
			required: ["facts"],
			additionalProperties: false,
		} as never,
		async execute(
			_id,
			params: {
				facts?: Array<{ text?: string; subject?: string; kind?: string }>;
			},
		) {
			const raw = Array.isArray(params.facts) ? params.facts : [];
			// The who-is-who firewall, and with one database per person it is a security
			// boundary rather than tidiness: a fact about the OWNER filed here would be a
			// fact about the owner surfacing in a stranger's conversation.
			const keep = raw
				.filter((item) => item?.text?.trim())
				.map((item) => ({
					text: (item.text as string).trim(),
					subject: asRelation(item.subject),
					kind: asKind(item.kind) ?? "context",
				}))
				.filter((fact) => fact.subject === "interlocutor");
			if (keep.length === 0) {
				context.ledger().record({
					tool: "manager_remember",
					argsKey: "none",
					summary: "remembered nothing (no interlocutor facts)",
				});
				return ok(
					"Nothing stored: owner/other facts are deliberately discarded. This " +
						"tool stores only durable facts about an interlocutor in that person's " +
						"contact memory; do not retry it in the Owner's chat.",
				);
			}
			const result = await withMemory(async (memory) => {
				const notes: string[] = [];
				for (const fact of keep) {
					const outcome = await memory.remember({
						text: fact.text,
						entity: context.contactName(),
						tags: ["fact", fact.kind],
						validFrom: context.now(),
					});
					notes.push(
						`Stored [f${outcome.id}] ${fact.text}${conflictNote(
							outcome.similar,
							outcome.id,
						)}`,
					);
				}
				return notes.join("\n");
			});
			if (typeof result !== "string") return fail(result.error);
			context.ledger().record({
				tool: "manager_remember",
				argsKey: keep.map((fact) => fact.text).join("|"),
				summary: `remembered ${keep.length} fact(s): ${brief(
					keep.map((fact) => fact.text).join("; "),
				)}`,
			});
			return ok(result);
		},
	});

	const recall = defineTool({
		name: "manager_recall",
		label: "Manager Recall",
		description:
			"Search your own long-term memory about this person. Use it to check what you already know before storing something, to find what a conversation may have made obsolete, or to answer a question about them from memory rather than guessing. Returns a ranked block; each line starts with the fact's id in [fN], which manager_revise and manager_forget take.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"What you are looking for, in words — e.g. 'where they work' or 'what we agreed about the deadline'.",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional filter; a fact must carry ALL of these. 'fact' = durable facts, 'episode' = what happened, plus identity/preference/agreement/context.",
				},
			},
			additionalProperties: false,
		} as never,
		async execute(_id, params: { query?: string; tags?: string[] }) {
			const query = params.query?.trim() || undefined;
			const tags = Array.isArray(params.tags)
				? params.tags.filter((tag) => typeof tag === "string" && tag.trim())
				: undefined;
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
			"Replace a fact that has stopped being true with what is true now — they changed job, moved, cancelled the plan. Give the id from its [fN] tag and the corrected statement. The old version is closed rather than erased, so the memory still knows what it used to believe and when. Prefer this over forget whenever there is a successor: forget is for a fact that was simply wrong.",
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
			const text = params.text?.trim();
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
			});
			return ok(`Forgotten [f${target}]: ${result.text}`);
		},
	});

	const done = defineTool({
		name: MEMORY_DONE_TOOL_NAME,
		label: "Manager Done",
		description:
			"End the memory pass. Call this when the memory matches the conversation — everything durable is stored, nothing stale is left standing — or when there was nothing worth changing at all. This is the ONLY way a memory pass ends; nothing is sent to anyone either way.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"Optional one line on what you changed, for the owner's log.",
				},
			},
			additionalProperties: false,
		} as never,
		async execute(_id, params: { summary?: string }) {
			context.ledger().finish();
			const summary = params.summary?.trim();
			return ok(
				summary ? `Memory pass finished: ${summary}` : "Memory pass finished.",
			);
		},
	});

	return [remember, recall, revise, forget, done];
}
