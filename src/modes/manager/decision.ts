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

/** The model's structured decision for a manager turn. */
export type ManagerDecision =
	| { kind: "reply"; text: string }
	| { kind: "silent"; reason?: string }
	| { kind: "none" };

/** Names of the tools defined here — fed to the visibility gate. */
export const MANAGER_TOOL_NAMES = ["manager_reply", "manager_silent"] as const;

/** A per-turn holder the tools write their decision into. */
export interface DecisionSink {
	record(decision: ManagerDecision): void;
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

/** Resolve the turn's outcome: reply text to send, or null to stay silent. */
export function resolveDecision(decision: ManagerDecision): string | null {
	return decision.kind === "reply" && decision.text.trim()
		? decision.text
		: null;
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

/** Build the manager decision tools bound to `sink`. Register with `pi.registerTool`. */
export function createManagerTools(sink: DecisionSink): ToolDefinition[] {
	const managerReply = defineTool({
		name: "manager_reply",
		label: "Manager Reply",
		description:
			"Deliver a reply to the current interlocutor. Only the text you pass here is sent; your reasoning is never shown. End your turn by calling exactly one of manager_reply or manager_silent.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "The message to send to the interlocutor.",
				},
			},
			required: ["text"],
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params: { text: string }) {
			const text = params.text?.trim();
			if (!text) return fail("manager_reply requires non-empty text.");
			sink.record({ kind: "reply", text });
			return ok("Reply queued for delivery.");
		},
	});

	const managerSilent = defineTool({
		name: "manager_silent",
		label: "Manager Silent",
		description:
			"Deliberately send nothing this turn (not addressed to you, the owner is handling it, or there is nothing to add). End your turn by calling exactly one of manager_reply or manager_silent.",
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: "string",
					description: "Optional short reason for staying silent.",
				},
			},
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params: { reason?: string }) {
			sink.record({
				kind: "silent",
				reason: params.reason?.trim() || undefined,
			});
			return ok("Staying silent this turn.");
		},
	});

	return [managerReply, managerSilent];
}
