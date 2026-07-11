/**
 * The manager's reply-decision tools, replacing qwen-code's fragile `[THINK]`/
 * `[NONE]` text sentinels.
 *
 * The model must finish a manager turn by calling exactly one of:
 *  - `manager_reply({ text })`  — deliver `text` to the interlocutor (the ONLY
 *    delivery channel; the model's reasoning never reaches Telegram);
 *  - `manager_silent({ reason })` — deliberately say nothing.
 *
 * The tools write into an injected {@link DecisionSink}; the runtime resets the
 * sink each turn and reads it on turn end. Policy: `manager_reply` → send its
 * text; `manager_silent` or no call at all → stay silent (the safe default). No
 * response-text parsing, so it is deterministic and unit-testable.
 */

import { defineTool, type ToolDefinition } from "../../pi/sdk";
import { FACT_KINDS, type FactKind } from "../../storage/contact-store";

/**
 * How the model classified the latest interlocutor message before acting. It is
 * a required tool parameter (a code-checkable decision trail that nudges a weak
 * local model to think before it types):
 *  - `question` — a real question / request that wants an answer;
 *  - `addressed_to_bot` — the bot is called by name or as the AI assistant;
 *  - `acknowledgement` — "ok", "thanks", a reaction; a reply is optional;
 *  - `chatter` — small talk / emoji; usually stay silent.
 */
export type MessageCategory =
	| "question"
	| "addressed_to_bot"
	| "acknowledgement"
	| "chatter";

export const MESSAGE_CATEGORIES: readonly MessageCategory[] = [
	"question",
	"addressed_to_bot",
	"acknowledgement",
	"chatter",
];

/** The model's structured decision for a manager turn. */
export type ManagerDecision =
	| {
			kind: "reply";
			text: string;
			category?: MessageCategory;
			needsReply?: boolean;
	  }
	| {
			kind: "silent";
			reason?: string;
			category?: MessageCategory;
			needsReply?: boolean;
	  }
	| { kind: "none" };

/** Coerce an untrusted string into a known category, defaulting to "question". */
function asCategory(value: unknown): MessageCategory {
	return MESSAGE_CATEGORIES.includes(value as MessageCategory)
		? (value as MessageCategory)
		: "question";
}

/** Names of the tools defined here — fed to the visibility gate. */
export const MANAGER_TOOL_NAMES = [
	"manager_reply",
	"manager_silent",
	"manager_remember",
	"manager_skip",
] as const;

/** A per-turn holder the tools write their decision into. */
export interface DecisionSink {
	record(decision: ManagerDecision): void;
}

/**
 * Who a remembered fact is about — the code-checkable who-is-who classification.
 * Only `interlocutor` facts are ever persisted; `owner`/`other` are dropped so
 * the model can never file the operator's own details under a contact.
 */
export type FactRelation = "interlocutor" | "owner" | "other";

export const FACT_RELATIONS: readonly FactRelation[] = [
	"interlocutor",
	"owner",
	"other",
];

/** A durable fact captured this turn, tagged with its subject relation and kind. */
export interface RememberedFact {
	text: string;
	subject: FactRelation;
	kind?: FactKind;
}

/** A per-turn holder the memory tools write recorded facts into. */
export interface FactSink {
	record(facts: RememberedFact[]): void;
}

/** Coerce an untrusted string into a known relation, defaulting to "other". */
function asRelation(value: unknown): FactRelation {
	return FACT_RELATIONS.includes(value as FactRelation)
		? (value as FactRelation)
		: "other";
}

/** Coerce an untrusted string into a known fact kind, or undefined. */
function asKind(value: unknown): FactKind | undefined {
	return FACT_KINDS.includes(value as FactKind)
		? (value as FactKind)
		: undefined;
}

/** Collects durable facts recorded this turn via `manager_remember`. */
export class FactState implements FactSink {
	private facts: RememberedFact[] = [];

	reset(): void {
		this.facts = [];
	}

	record(facts: RememberedFact[]): void {
		for (const fact of facts) {
			const text = fact.text.trim();
			if (!text) continue;
			if (this.facts.some((existing) => existing.text === text)) continue;
			this.facts.push({ ...fact, text });
		}
	}

	current(): RememberedFact[] {
		return [...this.facts];
	}
}

/** A mutable decision holder: reset each turn, read on turn end. */
export class DecisionState implements DecisionSink {
	private decision: ManagerDecision = { kind: "none" };

	reset(): void {
		this.decision = { kind: "none" };
	}

	record(decision: ManagerDecision): void {
		// First decisive call wins; a later call cannot silently override a reply.
		if (this.decision.kind === "none") this.decision = decision;
	}

	current(): ManagerDecision {
		return this.decision;
	}
}

/**
 * Resolve the turn's outcome: reply text to send, or null to stay silent.
 *
 * Safe self-contradiction downgrade: if the model called `manager_reply` yet its
 * OWN self-check says no reply is needed (`needs_reply: false`) and it classified
 * the message as pure `chatter`, honour that judgement and stay silent. This cuts
 * the false-positive case (blurting into banter) without ever swallowing a reply
 * the model deemed necessary — a `question`/`addressed_to_bot` or any
 * `needs_reply: true` reply is always delivered.
 */
export function resolveDecision(decision: ManagerDecision): string | null {
	if (decision.kind !== "reply" || !decision.text.trim()) return null;
	if (decision.needsReply === false && decision.category === "chatter") {
		return null;
	}
	return decision.text;
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

/**
 * Build the manager tools. `sink` receives the terminal reply/silent decision;
 * `factSink` receives durable facts from `manager_remember`. `onSkip` (optional)
 * fires when `manager_skip` runs, so the runtime can treat it as the terminal
 * action of a consolidation turn (which otherwise records nothing observable).
 * Register each with `pi.registerTool`.
 */
export function createManagerTools(
	sink: DecisionSink,
	factSink: FactSink,
	onSkip?: () => void,
): ToolDefinition[] {
	const categoryParam = {
		type: "string",
		enum: MESSAGE_CATEGORIES,
		description:
			"Classify the latest interlocutor message first: 'question' (wants an answer), 'addressed_to_bot' (you are called by name or as the AI), 'acknowledgement' (ok/thanks/reaction), or 'chatter' (small talk/emoji).",
	};
	const needsReplyParam = {
		type: "boolean",
		description:
			"Your own check: does this message actually require a reply? Reactions and chatter usually do not.",
	};

	const managerReply = defineTool({
		name: "manager_reply",
		label: "Manager Reply",
		description:
			"Deliver a reply to the current interlocutor. Only the text you pass here is sent; your reasoning is never shown. First classify the message (category) and self-check needs_reply. End your turn by calling exactly one of manager_reply or manager_silent.",
		parameters: {
			type: "object",
			properties: {
				category: categoryParam,
				needs_reply: needsReplyParam,
				text: {
					type: "string",
					description: "The message to send to the interlocutor.",
				},
			},
			required: ["category", "needs_reply", "text"],
			additionalProperties: false,
		} as never,
		async execute(
			_toolCallId,
			params: { text: string; category?: string; needs_reply?: boolean },
		) {
			const text = params.text?.trim();
			if (!text) return fail("manager_reply requires non-empty text.");
			sink.record({
				kind: "reply",
				text,
				category: asCategory(params.category),
				needsReply: params.needs_reply ?? true,
			});
			return ok("Reply queued for delivery.");
		},
	});

	const managerSilent = defineTool({
		name: "manager_silent",
		label: "Manager Silent",
		description:
			"Deliberately send nothing this turn (not addressed to you, the owner is handling it, or there is nothing to add). First classify the message (category) and self-check needs_reply. End your turn by calling exactly one of manager_reply or manager_silent.",
		parameters: {
			type: "object",
			properties: {
				category: categoryParam,
				needs_reply: needsReplyParam,
				reason: {
					type: "string",
					description: "Optional short reason for staying silent.",
				},
			},
			required: ["category", "needs_reply"],
			additionalProperties: false,
		} as never,
		async execute(
			_toolCallId,
			params: { reason?: string; category?: string; needs_reply?: boolean },
		) {
			sink.record({
				kind: "silent",
				reason: params.reason?.trim() || undefined,
				category: asCategory(params.category),
				needsReply: params.needs_reply ?? false,
			});
			return ok("Staying silent this turn.");
		},
	});

	const managerRemember = defineTool({
		name: "manager_remember",
		label: "Manager Remember",
		description:
			"Save durable, useful facts to private long-term memory. For EACH fact set subject — 'interlocutor' (about the person you are chatting with), 'owner' (about your operator), or 'other' — and kind (identity/preference/agreement/context). ONLY 'interlocutor' facts are stored; never file the owner's own details under a contact. Save stable facts (name, city, role, preferences, agreements), not passing chatter/mood/location. On a normal turn you may call this in addition to manager_reply/manager_silent.",
		parameters: {
			type: "object",
			properties: {
				facts: {
					type: "array",
					items: {
						type: "object",
						properties: {
							text: {
								type: "string",
								description: "One short durable fact.",
							},
							subject: {
								type: "string",
								enum: FACT_RELATIONS,
								description:
									"Who the fact is about: 'interlocutor' (stored), 'owner' or 'other' (dropped).",
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
			_toolCallId,
			params: {
				facts?: Array<{ text?: string; subject?: string; kind?: string }>;
			},
		) {
			const raw = Array.isArray(params.facts) ? params.facts : [];
			const facts: RememberedFact[] = raw
				.filter((item) => item?.text?.trim())
				.map((item) => ({
					text: (item.text as string).trim(),
					subject: asRelation(item.subject),
					kind: asKind(item.kind),
				}));
			factSink.record(facts);
			return ok(`Remembered ${facts.length} fact(s).`);
		},
	});

	const managerSkip = defineTool({
		name: "manager_skip",
		label: "Manager Skip",
		description:
			"End a memory-consolidation turn without saving anything (nothing durable is worth remembering).",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description: "Optional short reason for saving nothing.",
				},
			},
			additionalProperties: false,
		} as never,
		async execute() {
			onSkip?.();
			return ok("Nothing saved.");
		},
	});

	return [managerReply, managerSilent, managerRemember, managerSkip];
}
