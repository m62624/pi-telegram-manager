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
 *  - **consolidation** — the three interrogation probes, and nothing else. No reply, no
 *    silence, no memory tool, no computer. There is nobody to talk to on this turn.
 *  - **revise** — `manager_resolve_draft` alone: a reply of the model's own is held, and
 *    resolving it is the only way the turn can end.
 *  - **ordinary** — the owner's sandbox allowlist, minus the tools that belong to the two
 *    turns above. A turn where those existed would be a turn the model could mistake for
 *    one of them.
 *
 * Pure, and separate from the composition root precisely so that it can be tested: the
 * bug this file exists to prevent was invisible in code review for exactly as long as the
 * rule lived inline in a wiring expression.
 */
import { MANAGER_RESOLVE_TOOL_NAME } from "./decision";
import { INTERROGATION_TOOL_NAMES } from "./interrogation";

/** Matches a tool by name (structurally the runtime's `ToolMatcher`). */
export interface ToolNameMatcher {
	matches(name: string): boolean;
}

/** What the manager is doing right now. Both false = an ordinary reply turn. */
export interface ManagerTurnKind {
	/** A background memory pass is running (`isConsolidating`). */
	consolidating: boolean;
	/** A drafted reply is held and must be resolved (`isReviseTurn`). */
	revising: boolean;
}

const PROBES: readonly string[] = INTERROGATION_TOOL_NAMES;

/** Whether `name` is one of the consolidation interrogation probes. */
export function isProbeTool(name: string): boolean {
	return PROBES.includes(name);
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
			if (turn.consolidating) return isProbeTool(name);
			if (turn.revising) return name === MANAGER_RESOLVE_TOOL_NAME;
			return (
				name !== MANAGER_RESOLVE_TOOL_NAME &&
				!isProbeTool(name) &&
				base.matches(name)
			);
		},
	};
}
