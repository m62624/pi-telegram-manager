/**
 * Iterative fact-consolidation interrogation — the "who is who" memory brain.
 *
 * Instead of dumping the whole transcript at the model and trusting one prose
 * prompt ("extract facts about this person"), consolidation runs as a small
 * scripted state machine that asks the model ONE narrow question per turn:
 *
 *   1. identify  — confirm who the interlocutor is (and whether the owner is
 *      actually the person, which aborts the whole pass — nothing is saved);
 *   2. candidates — list durable facts, each tagged with its subject and
 *      durability; code keeps only interlocutor + durable ones;
 *   3. verify (per fact) — re-check EACH surviving candidate on its own, with a
 *      supporting quote that code confirms appears in the interlocutor's own
 *      lines. Facts never bleed into each other: one iteration, one decision, one
 *      piece of evidence.
 *
 * This module is the pure core (state + reducer) plus the three tools that feed
 * it. The runtime (manager controller) drives each probe as one agent turn using
 * the existing context-rebuild + turn_end-abort machinery, so a probe is exactly
 * one inference and can never spin.
 */
import { defineTool, type ToolDefinition } from "../../pi/sdk";
import { FACT_KINDS, type FactKind } from "../../storage/contact-store";
import { FACT_RELATIONS, type FactRelation } from "./decision";

/** Tool names of the interrogation probes — added to the manager whitelist. */
export const INTERROGATION_TOOL_NAMES = [
	"manager_identify",
	"manager_candidates",
	"manager_verify",
] as const;

/** A durable-fact candidate the model proposed in the candidates probe. */
export interface FactCandidate {
	text: string;
	subject: FactRelation;
	durable: boolean;
	kind?: FactKind;
}

/** The structured outcome of whichever probe tool the model called this turn. */
export type ProbeResult =
	| {
			tool: "identify";
			sameAsOwner: boolean;
			interlocutorName?: string;
			ownerLinesPresent?: boolean;
	  }
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

	const candidates = defineTool({
		name: "manager_candidates",
		label: "Manager Candidates",
		description:
			"Consolidation step 2. List every durable fact stated in this chat. For EACH item set subject (interlocutor/owner/other), durable (false for a passing mood, location, or 'today I…'), and kind (identity/preference/agreement/context). Only the interlocutor's own words count — do not attribute the owner's or the bot's statements to them.",
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
			"Consolidation step 3. Verify the ONE fact shown to you. Set keep=true only if it is genuinely about the interlocutor and durable, and provide evidence_quote — a short exact quote from THEIR message that supports it. Otherwise keep=false.",
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

	return [identify, candidates, verify];
}

// ── The pure reducer ────────────────────────────────────────────────────────

type Phase = "identify" | "candidates" | "verify" | "done";

/** The interrogation's evolving state, driven one probe at a time. */
export interface InterrogationState {
	interlocutorName: string;
	phase: Phase;
	/** Candidates that survived the code filter, awaiting per-fact verification. */
	queue: FactCandidate[];
	/** Index of the candidate currently being verified. */
	cursor: number;
	/** Candidates confirmed by verification (with supporting evidence). */
	confirmed: FactCandidate[];
	/** True when identify flagged a self-chat — nothing may be saved. */
	aborted: boolean;
}

/** Begin an interrogation for a contact. */
export function initInterrogation(
	interlocutorName: string,
): InterrogationState {
	return {
		interlocutorName,
		phase: "identify",
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
				directive: `[Step 1 of 3. Confirm identity before saving anything. The interlocutor should be ${name}. Call manager_identify with their name, whether the owner's own lines appear here, and same_as_owner (true only if this "interlocutor" is actually the owner). Save nothing yet.]`,
			};
		case "candidates":
			return {
				tool: "manager_candidates",
				directive: `[Step 2 of 3. List every durable fact about ${name} stated in this chat by calling manager_candidates. For each item set subject, durable, and kind. Only ${name}'s own words count — never attribute the owner's or the bot's statements to them.]`,
			};
		case "verify": {
			const candidate = state.queue[state.cursor];
			const text = candidate ? candidate.text : "";
			return {
				tool: "manager_verify",
				directive: `[Step 3 of 3 — fact ${state.cursor + 1} of ${state.queue.length}. Verify ONLY this fact about ${name}: "${text}". Call manager_verify with keep=true only if it is genuinely about ${name} and durable, plus evidence_quote — a short exact quote from ${name}'s own message. Otherwise keep=false.]`,
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
			return { ...state, phase: "candidates" };
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
