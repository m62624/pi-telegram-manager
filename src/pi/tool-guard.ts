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
	/** Optional hook when a call is blocked (for a UI notice / stats). */
	onBlock?: (toolName: string) => void;
}

/** The steer text returned to the model when it calls a blocked tool. */
export function blockedToolReason(toolName: string): string {
	return (
		`'${toolName}' is not available: you are running in the Telegram sandbox ` +
		`with no access to the computer. End your turn by calling exactly one of ` +
		`manager_reply (to answer the interlocutor) or manager_silent (to stay quiet).`
	);
}

/** Register the sandbox tool guard. Safe to call once at extension load. */
export function registerToolGuard(pi: ExtensionAPI, deps: ToolGuardDeps): void {
	pi.on("tool_call", async (event): Promise<ToolCallEventResult> => {
		if (!deps.isActive()) return {};
		const matcher = deps.matcher();
		if (matcher?.matches(event.toolName)) return {};
		deps.onBlock?.(event.toolName);
		return { block: true, reason: blockedToolReason(event.toolName) };
	});
}
