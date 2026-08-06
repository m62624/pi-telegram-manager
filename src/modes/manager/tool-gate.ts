/**
 * Which tools exist on THIS turn — because the manager runs three different kinds of
 * turn, and a tool from the wrong one does not merely go unused: it tells the model what
 * kind of turn it is in.
 *
 * That is not a theory. A live consolidation pass — a background memory review that
 * sends nothing to anyone — was handed the reply tools, because the sandbox only ever
 * special-cased the revise turn. The model saw `manager_reply` and `manager_silent` in
 * its tool list, read a transcript ending in somebody's question, and reasoned its way
 * into a reply turn: it called `manager_silent` "to end the turn", wrote a word of prose
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
 *  - **revise** — `manager_resolve_draft` alone: a reply of the model's own is held, and
 *    resolving it is the only way the turn can end.
 *  - **ordinary** — the owner's sandbox allowlist, minus the tools that belong to the two
 *    turns above (except `manager_remember`, which belongs to both: see below). A turn
 *    where the others existed would be a turn the model could mistake for a pass.
 *
 * Pure, and separate from the composition root precisely so that it can be tested: the
 * bug this file exists to prevent was invisible in code review for exactly as long as the
 * rule lived inline in a wiring expression.
 */
import { MANAGER_RESOLVE_TOOL_NAME } from "./decision";
import { MEMORY_REPLY_TOOL_NAME, MEMORY_TOOL_NAMES } from "./memory-tools";

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
	/** A drafted reply is held and must be resolved (`isReviseTurn`). */
	revising: boolean;
}

const MEMORY_TOOLS: readonly string[] = MEMORY_TOOL_NAMES;

/** Whether `name` is one of the memory verbs. */
export function isMemoryTool(name: string): boolean {
	return MEMORY_TOOLS.includes(name);
}

/**
 * Whether `name` is a memory verb that only a consolidation pass may call.
 *
 * `manager_remember` is the exception, and deliberately so: learning something while
 * talking to somebody is the moment it is worth writing down, and making the model
 * wait for a background pass to record it is how a fact gets lost. Looking things up,
 * rewriting them and dropping them are a pass's work — on a reply turn they are three
 * more ways to spend an inference on something other than the answer.
 */
function isPassOnlyMemoryTool(name: string): boolean {
	return isMemoryTool(name) && name !== MEMORY_REPLY_TOOL_NAME;
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
				return isMemoryTool(name);
			}
			if (turn.revising) return name === MANAGER_RESOLVE_TOOL_NAME;
			return (
				name !== MANAGER_RESOLVE_TOOL_NAME &&
				!isPassOnlyMemoryTool(name) &&
				base.matches(name)
			);
		},
	};
}
