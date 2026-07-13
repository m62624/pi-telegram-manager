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

/** A text or image content block (structural subset of the SDK's blocks). */
interface ContentBlock {
	type?: string;
	text?: string;
}

/** The minimal message shape the filter reads (structurally an `AgentMessage`). */
export interface FilterableMessage {
	role: string;
	// Optional: some custom `AgentMessage` variants (e.g. bash-execution) carry no
	// `content`. They are never user messages, so they are simply not Telegram turns.
	content?: string | ContentBlock[] | unknown;
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
 */
export function stripTelegramTurns<T extends FilterableMessage>(
	messages: readonly T[],
): T[] {
	const kept: T[] = [];
	let dropping = false;
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
