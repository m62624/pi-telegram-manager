/**
 * Shape the agent's final text into what actually gets sent to Telegram.
 *
 * Right now this owns one rule: the manager-mode `labeler`. When configured
 * (default `"LLM agent:"`), it is prepended as the first line of every outbound
 * business message so the human on the other end can see a bot is replying. An
 * empty labeler adds nothing, and we never double-apply a label the text
 * already starts with.
 *
 * Pure and string-only; the actual send (channel choice, splitting) is
 * `OutboundSender`'s job.
 */

/** Prepend `labeler` as a first line, unless it is empty or already present. */
export function applyLabeler(text: string, labeler?: string): string {
	const label = labeler?.trim();
	if (!label) return text;
	if (text === label || text.startsWith(`${label}\n`)) return text;
	return `${label}\n${text}`;
}

export interface ReplyPlan {
	/** Markdown to render and send. */
	markdown: string;
}

export interface RenderReplyOptions {
	/** Manager-mode label prepended to the first line (empty = none). */
	labeler?: string;
}

/** Turn an agent reply into a send plan, applying the optional labeler. */
export function renderReply(
	text: string,
	options: RenderReplyOptions = {},
): ReplyPlan {
	return { markdown: applyLabeler(text.trim(), options.labeler) };
}
