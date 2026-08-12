/**
 * The manager's reply-decision tools, replacing qwen-code's fragile `[THINK]`/
 * `[NONE]` text sentinels.
 *
 * The model must finish a manager turn by calling exactly one of:
 *  - `telegram_manager_reply({ text })`  — deliver `text` to the interlocutor (the ONLY
 *    delivery channel; the model's reasoning never reaches Telegram);
 *  - `telegram_manager_silent({ reason })` — deliberately say nothing.
 *
 * A HELD-DRAFT turn is the exception: reply/silent are hidden and blocked, and
 * `telegram_manager_resolve_draft` (send/refine/drop) is the only tool that ends it.
 *
 * The tools write into an injected {@link DecisionSink}; the runtime resets the
 * sink each turn and reads it on turn end. Policy: `telegram_manager_reply` → send its
 * text; `telegram_manager_silent` or no call at all → stay silent (the safe default). No
 * response-text parsing, so it is deterministic and unit-testable.
 */

import { defineTool, type ToolDefinition } from "../../pi/sdk";

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
			/** Telegram message id the reply threads to (from the `[#id]` tags). */
			replyTo?: number;
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
	"telegram_manager_reply",
	"telegram_manager_silent",
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
 * Safe self-contradiction downgrade: if the model called `telegram_manager_reply` yet its
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

/**
 * How the model resolved a HELD draft on a revise turn (new interlocutor messages
 * arrived while it was drafting a reply). The gate forces exactly one of these so a
 * ready answer to a real question is never silently dropped by a trailing chatter
 * message:
 *  - `send`   — deliver the held draft as-is (the new messages did not change it);
 *  - `refine` — deliver `text`, a rewrite of the draft that folds in the new info;
 *  - `drop`   — discard it (they explicitly retracted, answered themselves, or it
 *    was already answered).
 */
export type DraftResolution =
	| { action: "send" }
	| { action: "refine"; text: string }
	| { action: "drop"; reason?: string }
	| { action: "none" };

/** A per-turn holder the resolve-draft tool writes its decision into. */
export interface DraftResolutionSink {
	record(resolution: DraftResolution): void;
}

/** The resolve-draft tool name — revealed only on a revise turn (see the matcher). */
export const MANAGER_RESOLVE_TOOL_NAME = "telegram_manager_resolve_draft";

/** A mutable resolve-draft holder: reset each turn, read on turn end. */
export class DraftResolutionState implements DraftResolutionSink {
	private resolution: DraftResolution = { action: "none" };

	reset(): void {
		this.resolution = { action: "none" };
	}

	record(resolution: DraftResolution): void {
		// First decisive call wins.
		if (this.resolution.action === "none") this.resolution = resolution;
	}

	current(): DraftResolution {
		return this.resolution;
	}
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
 * Build the manager's two terminal tools. `sink` receives the reply/silent
 * decision. Register each with `pi.registerTool`.
 *
 * The memory verbs used to live here too. They moved to `memory-tools.ts` when the
 * store became a database the model can query: they are no longer one tool that
 * appends to a list, and grouping them with the reply decision made a turn's tool
 * list read as if remembering were part of answering. It is not — a fact is stored
 * the moment it is learned, and the turn still has to end in reply or silence.
 */
export function createManagerTools(sink: DecisionSink): ToolDefinition[] {
	const categoryParam = {
		type: "string",
		enum: MESSAGE_CATEGORIES,
		description:
			"Classify the latest interlocutor message first: 'question' (wants an answer — including a personal one asked of the owner, such as 'where are you?' or 'what are you doing?', however casual its tone), 'addressed_to_bot' (you are called by name or as the AI), 'acknowledgement' (ok/thanks/reaction, or the answer to something the owner asked for), or 'chatter' (banter between other people, emoji, jokes that ask nothing of anyone). This is a decision, not a comment: a reply you tag 'chatter' or 'acknowledgement' is DISCARDED unless you were addressed by name. If you are answering it, it is a 'question'.",
	};
	const needsReplyParam = {
		type: "boolean",
		description:
			"Your own check: does this message actually require a reply? Reactions and banter usually do not. Setting false while calling telegram_manager_reply contradicts itself and your reply will be discarded — if you are replying, this is true.",
	};

	const managerReply = defineTool({
		name: "telegram_manager_reply",
		label: "Telegram Manager Reply",
		description:
			"Deliver a reply to the current interlocutor. Only the text you pass here is sent; your reasoning is never shown. First classify the message (category) and self-check needs_reply. End your turn by calling exactly one of telegram_manager_reply or telegram_manager_silent — EXCEPT on a held-draft turn (the directive quotes a draft), where both are disabled and telegram_manager_resolve_draft ends the turn instead.",
		parameters: {
			type: "object",
			properties: {
				category: categoryParam,
				needs_reply: needsReplyParam,
				text: {
					type: "string",
					description: "The message to send to the interlocutor.",
				},
				reply_to: {
					type: "number",
					description:
						"Optional: the message id (the number in the [#id] tag) this reply answers, so the chat shows which message you replied to — pick the message from the party who addressed you (the one the turn directive names). Omit to thread to their latest message.",
				},
			},
			required: ["category", "needs_reply", "text"],
			additionalProperties: false,
		} as never,
		async execute(
			_toolCallId,
			params: {
				text: string;
				category?: string;
				needs_reply?: boolean;
				reply_to?: number;
			},
		) {
			const text = params.text?.trim();
			if (!text) return fail("telegram_manager_reply requires non-empty text.");
			sink.record({
				kind: "reply",
				text,
				category: asCategory(params.category),
				needsReply: params.needs_reply ?? true,
				replyTo:
					typeof params.reply_to === "number" ? params.reply_to : undefined,
			});
			return ok("Reply queued for delivery.");
		},
	});

	const managerSilent = defineTool({
		name: "telegram_manager_silent",
		label: "Telegram Manager Silent",
		description:
			"Deliberately send nothing this turn (not addressed to you, the owner is handling it, or there is nothing to add). First classify the message (category) and self-check needs_reply. End your turn by calling exactly one of telegram_manager_reply or telegram_manager_silent — EXCEPT on a held-draft turn (the directive quotes a draft), where both are disabled and telegram_manager_resolve_draft ends the turn instead.",
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

	return [managerReply, managerSilent];
}

/**
 * Build the resolve-draft tool. It is hidden on ordinary turns and revealed ONLY
 * on a revise turn (a held draft awaiting reconsideration); the runtime gates the
 * turn on it, so the model must choose send/refine/drop and can never silently
 * lose a ready answer. Register once with `pi.registerTool`.
 */
export function createDraftResolveTool(
	sink: DraftResolutionSink,
): ToolDefinition {
	return defineTool({
		name: MANAGER_RESOLVE_TOOL_NAME,
		label: "Telegram Manager Resolve Draft",
		description:
			"Resolve a reply of yours that is HELD instead of sent — because new messages arrived while you wrote it, or you wrote it as plain text (which never reaches Telegram). Available ONLY on such a turn, where telegram_manager_reply and telegram_manager_silent are disabled: this tool is the only way to end it. Choose 'send' to deliver the draft unchanged, 'refine' to deliver a rewrite that starts from the draft and folds in the new info (full final message in `text`), or 'drop' ONLY if the interlocutor retracted the question, answered it themselves, the owner already answered it, or your text was never meant as a message to them. A still-open question must be sent or refined, never dropped because of trailing small talk.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "refine", "drop"],
					description:
						"send (deliver the draft as-is) | refine (deliver `text`) | drop (discard).",
				},
				text: {
					type: "string",
					description:
						"Required for 'refine': the rewritten reply, based on your draft plus the new messages.",
				},
				reason: {
					type: "string",
					description: "Optional short reason, for 'drop'.",
				},
			},
			required: ["action"],
			additionalProperties: false,
		} as never,
		async execute(
			_toolCallId,
			params: { action?: string; text?: string; reason?: string },
		) {
			if (params.action === "refine") {
				const text = params.text?.trim();
				if (!text)
					return fail("telegram_manager_resolve_draft 'refine' requires text.");
				sink.record({ action: "refine", text });
				return ok("Refined reply queued for delivery.");
			}
			if (params.action === "drop") {
				sink.record({
					action: "drop",
					reason: params.reason?.trim() || undefined,
				});
				return ok("Held draft dropped.");
			}
			// Any other value (including "send") delivers the draft as-is — the safe
			// default that never loses a ready answer.
			sink.record({ action: "send" });
			return ok("Held draft queued for delivery.");
		},
	});
}
