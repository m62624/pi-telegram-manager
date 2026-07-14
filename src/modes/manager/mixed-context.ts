/**
 * Context isolation for the mixed mode's coding polarity.
 *
 * In mixed mode one Pi session runs two threads that must never bleed into each
 * other: the owner's live coding conversation and the Telegram-moderation turns
 * the manager injects. Both are recorded into the SAME session log, so when the
 * coding polarity is active and `pi.on("context")` hands us the raw session
 * messages, the Telegram turns are interleaved among the coding turns and would
 * pollute the owner's view.
 *
 * Every Telegram turn we inject (`triggerAgent` -> `pi.sendUserMessage`) is a
 * user message whose text carries a hidden {@link MIXED_TELEGRAM_MARKER}. Since
 * a manager turn is always exactly `[tagged user prompt] -> [assistant tool_use]
 * -> [tool result] -> (optional assistant prose)` up to the next real user
 * message, we can drop the whole turn as one contiguous block: start dropping at
 * a tagged user message and stop at the next UNtagged user message. Coding turns
 * (untagged) keep their tool_use<->tool_result pairs intact — isolation is by
 * construction, not by asking the model to forget.
 *
 * Pure and SDK-free: it works on a minimal structural message shape so it stays
 * unit-testable; `index.ts` passes the SDK's `AgentMessage[]` straight in.
 */

/**
 * A hidden, invisible signature prefixed to every Telegram turn prompt the
 * manager injects while mixed mode is active. Built from invisible-separator /
 * zero-width-space code points so it renders as nothing and is exceedingly
 * unlikely to occur in a human- or model-authored coding prompt. Distinct from
 * `identity.ts`'s `BOT_MARKER` (which tags outgoing Telegram messages) so the two
 * concerns never alias.
 */
export const MIXED_TELEGRAM_MARKER = "\u2063\u2063\u200b\u2063\u2063";

/** Prefix the hidden Telegram-turn marker onto an injected prompt. */
export function tagTelegramPrompt(prompt: string): string {
	return `${MIXED_TELEGRAM_MARKER}${prompt}`;
}

/** A content block of a message (structural subset of the SDK's blocks). */
interface ContentBlock {
	type?: string;
	text?: string;
	/** A `toolCall` block names the tool. */
	name?: string;
}

/** The minimal message shape the filter reads (structurally an `AgentMessage`). */
export interface FilterableMessage {
	role: string;
	// Optional: some custom `AgentMessage` variants (e.g. bash-execution) carry no
	// `content`. They are never user messages, so they are simply not Telegram turns.
	content?: string | ContentBlock[] | unknown;
	/** A `toolResult` message names the tool it answers. */
	toolName?: string;
}

/** Every tool the manager can call is named for it; nothing else may be. */
const MANAGER_TOOL_PREFIX = "manager_";

/**
 * Whether a message is a manager tool call or its result — the one signature of a
 * Telegram turn that survives when its tagged user prompt is gone.
 */
function isManagerToolActivity(message: FilterableMessage): boolean {
	if (message.role === "toolResult") {
		return message.toolName?.startsWith(MANAGER_TOOL_PREFIX) === true;
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return false;
	}
	return (message.content as ContentBlock[]).some(
		(block) =>
			block?.type === "toolCall" &&
			block.name?.startsWith(MANAGER_TOOL_PREFIX) === true,
	);
}

/**
 * Whether the transcript OPENS in the middle of a Telegram turn — i.e. the messages
 * before the first user message are a manager turn whose tagged prompt is missing.
 *
 * This is not a hypothetical. Pi's compaction cuts the history at "a user OR an
 * assistant message, never a tool result", so a cut can land inside a manager turn
 * and keep its assistant/tool-result tail while discarding the tagged user prompt
 * that opened it. Nothing then says whose turn that tail was — except the tools it
 * called, which are ours.
 */
function opensInsideTelegramTurn(
	messages: readonly FilterableMessage[],
): boolean {
	for (const message of messages) {
		if (message.role === "user") return false;
		if (isManagerToolActivity(message)) return true;
	}
	return false;
}

/** Flatten a message's text so the marker can be detected regardless of shape. */
function messageText(content: FilterableMessage["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block && typeof block === "object" && typeof block.text === "string"
					? block.text
					: "",
			)
			.join("");
	}
	return "";
}

/** Whether a user message is one of our injected Telegram-turn prompts. */
export function isTelegramTurn(message: FilterableMessage): boolean {
	return (
		message.role === "user" &&
		messageText(message.content).includes(MIXED_TELEGRAM_MARKER)
	);
}

/**
 * Drop every Telegram-moderation turn from a mixed-session transcript, leaving
 * only the owner's coding thread. A contiguous block is dropped from a tagged
 * user message up to (but not including) the next untagged user message, so an
 * assistant tool_use and its trailing tool result never orphan each other.
 *
 * A transcript that OPENS inside a manager turn (a compaction cut away the tagged
 * prompt) starts in the dropping state — see {@link opensInsideTelegramTurn}.
 */
export function stripTelegramTurns<T extends FilterableMessage>(
	messages: readonly T[],
): T[] {
	const kept: T[] = [];
	let dropping = opensInsideTelegramTurn(messages);
	for (const message of messages) {
		if (message.role === "user") {
			// A user message is the only boundary: a tagged one opens a drop block,
			// an untagged one (the owner) closes it.
			dropping = isTelegramTurn(message);
		}
		if (!dropping) kept.push(message);
	}
	return kept;
}

/**
 * The two message arrays a compaction is about to summarise (structurally Pi's
 * `CompactionPreparation`). They are the SAME arrays Pi will read after our hook
 * returns — the runner hands the event by reference — so rewriting them here is
 * what makes the summary a summary of the coding thread and nothing else.
 */
export interface CompactionPreparationLike {
	/** History that will be replaced by the summary. */
	messagesToSummarize: FilterableMessage[];
	/** The prefix of a turn cut in half, summarised separately. */
	turnPrefixMessages: FilterableMessage[];
}

/**
 * Take the manager's Telegram turns out of what a compaction will summarise, in
 * mixed mode.
 *
 * `pi.on("context")` — where the isolation normally happens — does NOT run for a
 * compaction: Pi summarises the raw session, and in mixed mode the raw session is
 * the owner's coding thread with the manager's moderation turns interleaved. So
 * without this, a compaction takes strangers' private messages, writes them into a
 * summary, and hands that summary back to the owner's coding thread as its memory
 * of what happened — the isolation the mode is built on, undone by the one code
 * path that never asks us what the model may see. It also spends the owner's whole
 * summary budget on chat moderation instead of the work.
 *
 * Returns how many messages were taken out, so the removal is observable.
 */
export function stripTelegramTurnsFromCompaction(
	preparation: CompactionPreparationLike,
): { removed: number } {
	const before =
		preparation.messagesToSummarize.length +
		preparation.turnPrefixMessages.length;
	preparation.messagesToSummarize = stripTelegramTurns(
		preparation.messagesToSummarize,
	);
	preparation.turnPrefixMessages = stripTelegramTurns(
		preparation.turnPrefixMessages,
	);
	const after =
		preparation.messagesToSummarize.length +
		preparation.turnPrefixMessages.length;
	return { removed: before - after };
}
