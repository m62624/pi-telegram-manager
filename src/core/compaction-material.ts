/**
 * What the summariser reads when the first attempt read too much.
 *
 * A compaction hands the model the whole history in ONE prompt, at the exact moment the
 * context is at its fullest — and if the provider has no room left to answer, the answer
 * is empty. That is not a hypothetical: it happened, and an empty answer was accepted as
 * a summary (`core/compaction-run.ts` has the receipt).
 *
 * The way out is arithmetic. Tool output is 80-90% of the characters in a coding session
 * and, by the brief we hand the summariser ourselves, the least of its worth: a file can
 * be read again, a thing the person said an hour ago cannot. So the retry summarises what
 * was SAID — the user's messages and the model's own words — and leaves out the tool
 * traffic entirely: the results, and the calls, whose arguments carry whole files.
 *
 * Structural typing only: `role`/`content` is all we need, and taking Pi's schema by
 * shape rather than by import keeps this testable with three plain objects.
 */

/** A message as Pi's compaction prepares it (structurally an `AgentMessage`). */
interface MessageLike {
	role?: unknown;
	content?: unknown;
}

/** A content block inside a message. */
interface BlockLike {
	type?: unknown;
}

/** Blocks that are tool traffic rather than something anybody said. */
function isToolBlock(block: unknown): boolean {
	if (typeof block !== "object" || block === null) return false;
	const type = (block as BlockLike).type;
	return type === "toolCall" || type === "toolResult";
}

/** Whether anything is left of a message once the tool traffic is out of it. */
function hasContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (Array.isArray(content)) return content.length > 0;
	return content !== undefined && content !== null;
}

/**
 * `messages` with the tool traffic removed: `toolResult` messages dropped whole, and tool
 * calls taken out of the assistant messages that made them (their arguments are as big as
 * the file they wrote). Everything anyone SAID survives, in order.
 *
 * Returns a new array — Pi's own `preparation` is not touched, so the fallback path still
 * has the material it planned on.
 */
export function conversationOnly(messages: readonly unknown[]): unknown[] {
	const kept: unknown[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const { role, content } = message as MessageLike;
		if (role === "toolResult") continue;
		if (!Array.isArray(content)) {
			if (hasContent(content)) kept.push(message);
			continue;
		}
		const blocks = content.filter((block) => !isToolBlock(block));
		if (blocks.length === 0) continue;
		kept.push({ ...message, content: blocks });
	}
	return kept;
}
