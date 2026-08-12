/**
 * Which tools exist on THIS turn — because the manager runs three different kinds of
 * turn, and a tool from the wrong one does not merely go unused: it tells the model what
 * kind of turn it is in.
 *
 * That is not a theory. A live consolidation pass — a background memory review that
 * sends nothing to anyone — was handed the reply tools, because the sandbox only ever
 * special-cased the revise turn. The model saw `telegram_manager_reply` and `telegram_manager_silent` in
 * its tool list, read a transcript ending in somebody's question, and reasoned its way
 * into a reply turn: it called `telegram_manager_silent` "to end the turn", wrote a word of prose
 * meant for the chat, and in other passes went back and called the first interrogation
 * step a second time until the runtime aborted the run. Nothing wrong was ever sent — the
 * decision is dropped on a consolidation turn — but the pass was wasted, and the owner
 * read a trace of the bot apparently deciding to answer somebody it was only remembering.
 *
 * So the tool set is a function of the turn, with one rule and no overlap:
 *
 *  - **consolidation** — the memory verbs, and nothing else. No reply, no silence, no
 *    computer: there is nobody to talk to on this turn. Once the pass has said it is
 *    finished: no tools at all, so the only way left to end the run is the word the
 *    context asks for.
 *  - **revise** — `telegram_manager_resolve_draft` alone: a reply of the model's own is held, and
 *    resolving it is the only way the turn can end.
 *  - **ordinary** — the owner's sandbox allowlist, minus the tools that belong to the two
 *    turns above. That now includes EVERY memory verb, `telegram_manager_remember` included: a
 *    live reply turn used to be allowed to write (the reasoning was that a fact learned
 *    mid-conversation is worth saving before it is lost), and a real session showed the
 *    cost of that — two extra inference round-trips writing to memory before the reply
 *    ever went out, one of them a blocked near-duplicate nobody ever came back to
 *    resolve. Reading is unaffected: the memory block a reply turn sees is assembled
 *    automatically before sampling (`memory-block.ts`), never through a tool call, so
 *    dropping `telegram_manager_remember` here costs nothing but latency. A turn where the other
 *    verbs existed would be a turn the model could mistake for a pass.
 *
 * Pure, and separate from the composition root precisely so that it can be tested: the
 * bug this file exists to prevent was invisible in code review for exactly as long as the
 * rule lived inline in a wiring expression.
 */
import { MANAGER_RESOLVE_TOOL_NAME } from "./decision";
import { MEMORY_TOOL_NAMES } from "./memory-tools";

/** Matches a tool by name (structurally the runtime's `ToolMatcher`). */
export interface ToolNameMatcher {
	matches(name: string): boolean;
}

/** What the manager is doing right now. All false = an ordinary reply turn. */
export interface ManagerTurnKind {
	/** A background memory pass is running (`isConsolidating`). */
	consolidating: boolean;
	/**
	 * The memory pass is over and only waiting for the run to end
	 * (`isConsolidationDone`). There is nothing left to do, so there is no tool left to
	 * offer: the context says so in words, and the tool list must say the same thing.
	 *
	 * It did not, and the model did what a model does when a finished instruction is
	 * contradicted by a live tool: it called the tool. Again — on a pass it had just
	 * declared finished — and the runtime aborted the run to stop it. "Operation
	 * aborted" in the owner's feed, once per memory pass.
	 */
	consolidationDone?: boolean;
	/** Recall is temporarily hidden after too many inspection-only calls. */
	recallBlocked?: boolean;
	/** A drafted reply is held and must be resolved (`isReviseTurn`). */
	revising: boolean;
}

const MEMORY_TOOLS: readonly string[] = MEMORY_TOOL_NAMES;

/** Whether `name` is one of the memory verbs. */
export function isMemoryTool(name: string): boolean {
	return MEMORY_TOOLS.includes(name);
}

/**
 * The tools available on the current turn. `base` is the owner's sandbox allowlist (the
 * manager's own tools plus whatever `manager.allowedTools` permits); the turn kind
 * decides which slice of it the model may see and call.
 *
 * Consolidation is checked FIRST: a memory pass can be running while a chat happens to
 * hold a draft, and the pass owns the turn.
 */
export function managerToolGate(
	base: ToolNameMatcher,
	turn: ManagerTurnKind,
): ToolNameMatcher {
	return {
		matches: (name: string): boolean => {
			if (turn.consolidating) {
				if (turn.consolidationDone) return false;
				if (turn.recallBlocked && name === "telegram_manager_recall")
					return false;
				return isMemoryTool(name);
			}
			if (turn.revising) return name === MANAGER_RESOLVE_TOOL_NAME;
			return (
				name !== MANAGER_RESOLVE_TOOL_NAME &&
				!isMemoryTool(name) &&
				base.matches(name)
			);
		},
	};
}
