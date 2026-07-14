/**
 * Runtime enforcement half of the telegram-sandbox (manager mode).
 *
 * The visibility gate ({@link ./tool-visibility}) already hides every tool the
 * sandbox does not allow, so a well-behaved model never even sees `read`,
 * `bash`, `ask_user`, or a foreign extension's tools while the manager runs.
 * This guard is the belt to that gate's braces: it registers a `tool_call`
 * handler that *blocks* execution of any call that is not on the manager's
 * allowlist while the manager is active — catching anything that could bypass
 * visibility (a tool invoked by id, a stale active-list, a future SDK quirk) and
 * turning it into a steer that points the model back at its two real tools.
 *
 * When the manager is inactive it is a no-op, so mode 1 and the plain terminal
 * are never affected. Mirrors the `tool_call` deny pattern in `pi-approval-modes`
 * (`src/runtime/tool-approval.ts`), scoped here to a fixed allowlist.
 */

import type { ExtensionAPI, ToolCallEventResult } from "./sdk";
import type { ToolMatcher } from "./tool-allow";

export interface ToolGuardDeps {
	/** Whether the telegram-sandbox (manager) is currently active. */
	isActive: () => boolean;
	/** The allowlist for the active sandbox; null while inactive. */
	matcher: () => ToolMatcher | null;
	/**
	 * How the model should end THIS turn, when the tools that end it are not the
	 * usual pair (a revise turn exposes only the resolve-draft tool). Omitted or
	 * undefined → the default reply/silent hint.
	 */
	endTurnHint?: () => string | undefined;
	/** Optional hook when a call is blocked (for a UI notice / stats). */
	onBlock?: (toolName: string) => void;
}

/** Default steer: the normal turn ends with exactly one of the two decision tools. */
export const DECIDE_END_TURN_HINT =
	"End your turn by calling exactly one of manager_reply (to answer the " +
	"interlocutor) or manager_silent (to stay quiet).";

/**
 * Steer for a revise turn: reply/silent/remember are hidden and blocked, and the
 * held draft is resolved through the single tool that is active. Without this the
 * guard used to answer a blocked `manager_reply` by telling the model to call
 * `manager_reply` — a contradiction that burns the whole turn.
 */
export const RESOLVE_DRAFT_END_TURN_HINT =
	"A drafted reply is held for review, so manager_reply / manager_silent are " +
	"disabled this turn. End your turn by calling manager_resolve_draft with " +
	"action 'send', 'refine' (with the corrected text), or 'drop'.";

/**
 * Steer for a consolidation pass: there is nobody to answer on this turn, so the reply
 * tools do not exist. Without a hint of its own, a blocked `manager_silent` here was
 * answered with the default "decide the turn with manager_reply or manager_silent" —
 * which is the one thing that cannot be done, and the model would keep trying.
 */
export const CONSOLIDATION_END_TURN_HINT =
	"This is a background memory pass, not a conversation: nothing you write reaches " +
	"anyone, and manager_reply / manager_silent do not exist on this turn. Answer the " +
	"interrogation step shown in the directive, by calling the one tool it names.";

/** The steer text returned to the model when it calls a blocked tool. */
export function blockedToolReason(
	toolName: string,
	endTurnHint?: string,
): string {
	return (
		`'${toolName}' is not available: you are running in the Telegram sandbox ` +
		`with no access to the computer. ${endTurnHint ?? DECIDE_END_TURN_HINT}`
	);
}

/** Register the sandbox tool guard. Safe to call once at extension load. */
export function registerToolGuard(pi: ExtensionAPI, deps: ToolGuardDeps): void {
	pi.on("tool_call", async (event): Promise<ToolCallEventResult> => {
		if (!deps.isActive()) return {};
		const matcher = deps.matcher();
		if (matcher?.matches(event.toolName)) return {};
		deps.onBlock?.(event.toolName);
		return {
			block: true,
			reason: blockedToolReason(event.toolName, deps.endTurnHint?.()),
		};
	});
}
