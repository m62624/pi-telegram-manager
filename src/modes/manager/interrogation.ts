/**
 * Iterative fact-consolidation interrogation — the "who is who" memory brain.
 *
 * Instead of dumping the whole transcript at the model and trusting one prose
 * prompt ("extract facts about this person"), consolidation runs as a small
 * scripted state machine that asks the model ONE narrow question per turn:
 *
 *   1. identify  — confirm who the interlocutor is (and whether the owner is
 *      actually the person, which aborts the whole pass — nothing is saved);
 *   2. review    — of what is ALREADY remembered, what has this conversation
 *      overturned? Skipped entirely when the contact's memory is empty;
 *   3. candidates — list durable facts, each tagged with its subject and
 *      durability; code keeps only interlocutor + durable ones;
 *   4. verify (per fact) — re-check EACH surviving candidate on its own, with a
 *      supporting quote that code confirms appears in the interlocutor's own
 *      lines. Facts never bleed into each other: one iteration, one decision, one
 *      piece of evidence.
 *
 * The review step exists because memory that only ever GROWS eventually lies. A
 * fact was true when it was learned and can stop being true afterwards — the job
 * changed, the trip is over, the thing they were waiting for arrived — and a bot
 * that resurfaces it forever will one day tell somebody, with total confidence,
 * something they themselves corrected weeks ago. Nothing could remove a fact but
 * a schema migration wiping every contact's memory at once.
 *
 * Forgetting is gated by the SAME evidence rule as remembering, and that is the
 * point: a fact may only be dropped when the interlocutor's own words in this
 * conversation say so, and code — not the model — checks the quote against their
 * lines. A model that decides on its own that it "probably does not need this any
 * more" is a model that quietly erases what it was told; it must produce the
 * sentence that overturns the fact, or the fact stays.
 *
 * This module is the pure core (state + reducer) plus the four tools that feed
 * it. The runtime (manager controller) drives each probe as one agent turn using
 * the existing context-rebuild + turn_end-abort machinery, so a probe is exactly
 * one inference and can never spin.
 */
import { defineTool, type ToolDefinition } from "../../pi/sdk";
import { FACT_KINDS, type FactKind } from "../../storage/contact-store";
import { FACT_RELATIONS, type FactRelation } from "./decision";

/**
 * Tool names of the interrogation probes — added to the manager whitelist.
 *
 * The ORDER of this list is part of the prompt: tool schemas are rendered into the
 * head, and the same tools in a different order are different bytes (see
 * `pi/tool-visibility.ts`). It is fixed by the registry, not by us, but there is no
 * reason to make it move.
 */
export const INTERROGATION_TOOL_NAMES = [
	"manager_identify",
	"manager_forget",
	"manager_candidates",
	"manager_verify",
] as const;

/**
 * How many facts one pass may drop.
 *
 * A cap, not a policy: even with the evidence check behind it, a single confused pass
 * must not be able to empty a contact's memory. What genuinely goes stale goes stale a
 * fact or two at a time; a pass that wants to drop everything is a pass that has
 * misread who it is talking to, and the next one can drop the rest.
 */
export const FORGET_LIMIT = 3;

/** A durable-fact candidate the model proposed in the candidates probe. */
export interface FactCandidate {
	text: string;
	subject: FactRelation;
	durable: boolean;
	kind?: FactKind;
}

/** A fact already in the contact's memory when the pass began. */
export interface KnownFact {
	text: string;
	kind?: FactKind;
}

/** One stored fact the model says this conversation has overturned. */
export interface ForgetRequest {
	/** 1-based, into the numbered list the review directive showed. */
	number: number;
	/** What they said that overturns it — checked against their own lines. */
	evidenceQuote?: string;
}

/** The structured outcome of whichever probe tool the model called this turn. */
export type ProbeResult =
	| {
			tool: "identify";
			sameAsOwner: boolean;
			interlocutorName?: string;
			ownerLinesPresent?: boolean;
	  }
	| { tool: "forget"; items: ForgetRequest[] }
	| { tool: "candidates"; items: FactCandidate[] }
	| { tool: "verify"; keep: boolean; evidenceQuote?: string };

/** A per-probe holder the interrogation tools write their result into. */
export interface ProbeSink {
	record(result: ProbeResult): void;
}

/** Mutable probe-result holder: reset before each probe, read on turn end. */
export class ProbeState implements ProbeSink {
	private result: ProbeResult | null = null;

	reset(): void {
		this.result = null;
	}

	record(result: ProbeResult): void {
		// First call this probe wins.
		if (!this.result) this.result = result;
	}

	current(): ProbeResult | null {
		return this.result;
	}
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

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

/** Build the three interrogation tools, all writing into `sink`. */
export function createInterrogationTools(sink: ProbeSink): ToolDefinition[] {
	const identify = defineTool({
		name: "manager_identify",
		label: "Manager Identify",
		description:
			"Consolidation step 1. Confirm who this conversation is with before saving anything: the interlocutor's name, whether the owner's own lines appear in the transcript, and whether the interlocutor is actually the owner (same_as_owner). If same_as_owner is true, nothing will be saved.",
		parameters: {
			type: "object",
			properties: {
				interlocutor_name: {
					type: "string",
					description: "The interlocutor's name as it appears in their lines.",
				},
				owner_lines_present: {
					type: "boolean",
					description: "Whether the owner's own messages appear in this chat.",
				},
				same_as_owner: {
					type: "boolean",
					description:
						"True if the 'interlocutor' is actually the owner themselves (a self-chat).",
				},
			},
			required: ["same_as_owner"],
			additionalProperties: false,
		} as never,
		async execute(
			_id,
			params: {
				interlocutor_name?: string;
				owner_lines_present?: boolean;
				same_as_owner?: boolean;
			},
		) {
			sink.record({
				tool: "identify",
				sameAsOwner: params.same_as_owner === true,
				interlocutorName: params.interlocutor_name?.trim() || undefined,
				ownerLinesPresent: params.owner_lines_present === true,
			});
			return ok("Identity noted.");
		},
	});

	const forget = defineTool({
		name: "manager_forget",
		label: "Manager Forget",
		description:
			"Consolidation step 2. Of the facts you ALREADY remember about this person (numbered in the step), which ones has this conversation overturned? A fact is overturned only when their own words here say so — they changed job, the trip is over, they no longer want what they wanted. For each, give its number and evidence_quote: a short exact quote of what THEY typed that overturns it. Pass an empty list if nothing here contradicts what you know. Never drop a fact merely because it was not mentioned again.",
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							number: {
								type: "number",
								description: "The number of the remembered fact to drop.",
							},
							evidence_quote: {
								type: "string",
								description:
									"A short exact quote of what they typed that overturns it.",
							},
						},
						required: ["number", "evidence_quote"],
						additionalProperties: false,
					},
					description: "Facts this conversation overturned (may be empty).",
				},
			},
			required: ["items"],
			additionalProperties: false,
		} as never,
		async execute(
			_id,
			params: {
				items?: Array<{ number?: number; evidence_quote?: string }>;
			},
		) {
			const raw = Array.isArray(params.items) ? params.items : [];
			const items: ForgetRequest[] = raw
				.filter((item) => Number.isFinite(item?.number))
				.map((item) => ({
					number: Number(item.number),
					evidenceQuote: item.evidence_quote?.trim() || undefined,
				}));
			sink.record({ tool: "forget", items });
			return ok(
				items.length === 0
					? "Nothing to unlearn."
					: `Noted ${items.length} fact(s) to re-check.`,
			);
		},
	});

	const candidates = defineTool({
		name: "manager_candidates",
		label: "Manager Candidates",
		description:
			"Consolidation step 3. List the durable facts stated in this chat that you do NOT already remember — the facts you already hold are listed for you, and re-listing them costs you the room to verify a real one. For EACH item set subject (interlocutor/owner/other), durable (false for a passing mood, location, or 'today I…'), and kind (identity/preference/agreement/context). Only the interlocutor's own words count — never the owner's or the bot's, and never text a '↳' line marks as quoted, answered or forwarded: those are someone else's words carried inside their message.",
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							text: { type: "string", description: "One short fact." },
							subject: {
								type: "string",
								enum: FACT_RELATIONS,
								description: "Who the fact is about.",
							},
							durable: {
								type: "boolean",
								description:
									"True only for a lasting fact, not a passing state.",
							},
							kind: {
								type: "string",
								enum: FACT_KINDS,
								description: "identity | preference | agreement | context.",
							},
						},
						required: ["text", "subject", "durable"],
						additionalProperties: false,
					},
					description: "Candidate facts, each tagged.",
				},
			},
			required: ["items"],
			additionalProperties: false,
		} as never,
		async execute(
			_id,
			params: {
				items?: Array<{
					text?: string;
					subject?: string;
					durable?: boolean;
					kind?: string;
				}>;
			},
		) {
			const raw = Array.isArray(params.items) ? params.items : [];
			const items: FactCandidate[] = raw
				.filter((item) => item?.text?.trim())
				.map((item) => ({
					text: (item.text as string).trim(),
					subject: asRelation(item.subject),
					durable: item.durable === true,
					kind: asKind(item.kind),
				}));
			sink.record({ tool: "candidates", items });
			return ok(`Noted ${items.length} candidate(s).`);
		},
	});

	const verify = defineTool({
		name: "manager_verify",
		label: "Manager Verify",
		description:
			"Consolidation step 4. Verify the ONE fact shown to you. Set keep=true only if it is genuinely about the interlocutor and durable, and provide evidence_quote — a short exact quote of what THEY typed. A quote lifted from a '↳' line (someone else's message they replied to, quoted or forwarded) is not their words and will be rejected. Otherwise keep=false.",
		parameters: {
			type: "object",
			properties: {
				keep: {
					type: "boolean",
					description: "Whether to keep this fact.",
				},
				evidence_quote: {
					type: "string",
					description:
						"A short exact quote from the interlocutor's own message supporting the fact.",
				},
			},
			required: ["keep"],
			additionalProperties: false,
		} as never,
		async execute(_id, params: { keep?: boolean; evidence_quote?: string }) {
			sink.record({
				tool: "verify",
				keep: params.keep === true,
				evidenceQuote: params.evidence_quote?.trim() || undefined,
			});
			return ok("Verification noted.");
		},
	});

	return [identify, forget, candidates, verify];
}

// ── The pure reducer ────────────────────────────────────────────────────────

type Phase = "identify" | "review" | "candidates" | "verify" | "done";

/** The interrogation's evolving state, driven one probe at a time. */
export interface InterrogationState {
	interlocutorName: string;
	phase: Phase;
	/**
	 * What was already remembered about this contact when the pass began — the list
	 * the review step is asked about, and the list its numbers index into. Captured
	 * once, so a fact written mid-pass cannot renumber the question being answered.
	 */
	known: KnownFact[];
	/** Remembered facts this conversation overturned, evidence checked. */
	dropped: KnownFact[];
	/** Candidates that survived the code filter, awaiting per-fact verification. */
	queue: FactCandidate[];
	/** Index of the candidate currently being verified. */
	cursor: number;
	/** Candidates confirmed by verification (with supporting evidence). */
	confirmed: FactCandidate[];
	/** True when identify flagged a self-chat — nothing may be saved. */
	aborted: boolean;
}

/** Begin an interrogation for a contact, against what is already remembered. */
export function initInterrogation(
	interlocutorName: string,
	known: readonly KnownFact[] = [],
): InterrogationState {
	return {
		interlocutorName,
		phase: "identify",
		known: [...known],
		dropped: [],
		queue: [],
		cursor: 0,
		confirmed: [],
		aborted: false,
	};
}

export function isDone(state: InterrogationState): boolean {
	return state.phase === "done";
}

/** The tool the current phase expects and the directive shown to the model. */
export function currentProbe(state: InterrogationState): {
	tool: string;
	directive: string;
} {
	const name = state.interlocutorName;
	switch (state.phase) {
		case "identify":
			return {
				tool: "manager_identify",
				directive: `[Step 1 of 4. This chat is with ${name} — a specific account whose identity is already confirmed; do not second-guess it from a matching name. Call manager_identify with their name, whether the owner's own lines appear here, and same_as_owner=false unless this transcript is literally the owner's own self-chat. Save nothing yet.]`,
			};
		case "review": {
			const numbered = state.known
				.map((fact, index) => `${index + 1}. ${fact.text}`)
				.join("\n");
			return {
				tool: "manager_forget",
				directive: `[Step 2 of 4. This is what you already remember about ${name}:\n${numbered}\n\nHas anything ${name} said in THIS conversation overturned any of it — a job they have left, a plan they have cancelled, something they no longer want? Call manager_forget with the number of each such fact and evidence_quote: a short exact quote of what ${name} TYPED that overturns it. A fact that simply was not mentioned again is not overturned — leave it. Nothing contradicted? Call manager_forget with an empty list.]`,
			};
		}
		case "candidates":
			return {
				tool: "manager_candidates",
				directive: `[Step 3 of 4. List the durable facts about ${name} stated in this chat that you do NOT already remember (what you remember was listed in the previous step — do not repeat it back). Call manager_candidates. For each item set subject, durable, and kind. Only ${name}'s own words count: the speaker of a line is its prefix and nothing else, and a '↳' line under it holds words written by SOMEONE ELSE (quoted, answered or forwarded). Never attribute the owner's, the bot's, or a quoted person's statements to ${name}.]`,
			};
		case "verify": {
			const candidate = state.queue[state.cursor];
			const text = candidate ? candidate.text : "";
			return {
				tool: "manager_verify",
				directive: `[Step 4 of 4 — fact ${state.cursor + 1} of ${state.queue.length}. Verify ONLY this fact about ${name}: "${text}". Call manager_verify with keep=true only if it is genuinely about ${name} and durable, plus evidence_quote — a short exact quote of what ${name} TYPED, never a quote taken from a '↳' line (those words are someone else's). Otherwise keep=false.]`,
			};
		}
		default:
			return { tool: "", directive: "" };
	}
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether a quote appears in any of the interlocutor's own transcript lines. */
function quoteSupported(
	quote: string | undefined,
	interlocutorLines: readonly string[],
): boolean {
	const needle = normalize(quote ?? "");
	if (!needle) return false;
	return interlocutorLines.some((line) => normalize(line).includes(needle));
}

/**
 * Advance the interrogation by one probe result. `interlocutorLines` are the
 * interlocutor's own transcript lines (for the evidence check); `verifyLimit`
 * caps how many candidates are individually verified. A missing/mismatched
 * result is handled safely — identify/candidates end the pass with nothing, a
 * bad verify drops just that one fact — so the loop always terminates.
 */
export function advance(
	state: InterrogationState,
	result: ProbeResult | null,
	interlocutorLines: readonly string[],
	verifyLimit: number,
): InterrogationState {
	switch (state.phase) {
		case "identify": {
			if (result?.tool !== "identify" || result.sameAsOwner) {
				return { ...state, phase: "done", aborted: true };
			}
			// Nothing remembered yet, nothing to review: do not spend an inference asking
			// a new contact which of their zero facts has gone stale.
			return {
				...state,
				phase: state.known.length > 0 ? "review" : "candidates",
			};
		}
		case "review": {
			// A missing or fumbled answer here means "nothing to unlearn", never "end the
			// pass": review is the one optional step, and losing a whole interrogation
			// because the model muddled an OPTIONAL question would cost more than it saves.
			if (result?.tool !== "forget") return { ...state, phase: "candidates" };
			const dropped: KnownFact[] = [];
			const seen = new Set<number>();
			for (const item of result.items) {
				if (dropped.length >= FORGET_LIMIT) break;
				const index = item.number - 1;
				const fact = state.known[index];
				// It must exist, it must not be named twice, and — the rule that makes this
				// safe — they must have SAID something that overturns it, in their own words,
				// in this conversation. Code checks the quote; the model only points at it.
				if (!fact || seen.has(index)) continue;
				if (!quoteSupported(item.evidenceQuote, interlocutorLines)) continue;
				seen.add(index);
				dropped.push(fact);
			}
			return { ...state, dropped, phase: "candidates" };
		}
		case "candidates": {
			if (result?.tool !== "candidates") {
				return { ...state, phase: "done" };
			}
			const queue = result.items
				.filter((item) => item.subject === "interlocutor" && item.durable)
				.slice(0, Math.max(0, verifyLimit));
			if (queue.length === 0) return { ...state, phase: "done" };
			return { ...state, phase: "verify", queue, cursor: 0 };
		}
		case "verify": {
			const candidate = state.queue[state.cursor];
			const confirmed =
				candidate &&
				result?.tool === "verify" &&
				result.keep &&
				quoteSupported(result.evidenceQuote, interlocutorLines)
					? [...state.confirmed, candidate]
					: state.confirmed;
			const cursor = state.cursor + 1;
			const phase = cursor >= state.queue.length ? "done" : "verify";
			return { ...state, confirmed, cursor, phase };
		}
		default:
			return state;
	}
}

/** The facts to persist once the interrogation is done (empty when aborted). */
export function finalFacts(state: InterrogationState): FactCandidate[] {
	return state.aborted ? [] : state.confirmed;
}

/**
 * The facts to unlearn once the interrogation is done (empty when aborted).
 *
 * An aborted pass forgets nothing for the same reason it remembers nothing: it decided
 * it does not know who it is looking at, and a pass that cannot say who this is has no
 * business editing their memory.
 */
export function droppedFacts(state: InterrogationState): KnownFact[] {
	return state.aborted ? [] : state.dropped;
}
