/**
 * Extracting the tail of a Pi session for the `/resume` history preview.
 *
 * When the owner resumes a DIFFERENT session, the Telegram topic is otherwise blank
 * about what they just restored: the terminal shows the whole conversation (Pi loads it
 * natively), but the chat shows nothing, so there is no way to tell from the phone which
 * history is now live. This pulls the last few user/assistant exchanges so `index.ts`
 * can replay them into the personal topic as display-only cards — for the owner's eyes
 * only, never fed back to the agent and never echoed to the terminal.
 *
 * Pure over a structural message shape (no SDK, no grammY), so it is unit-testable on
 * plain fakes. Tool calls and tool results are dropped — only what a person reads as
 * conversation survives — and the hidden Telegram-turn marker is stripped so a replayed
 * prompt reads clean.
 */
import { MIXED_TELEGRAM_MARKER } from "../modes/manager/mixed-context";

/** A content block of a message (structural subset of the SDK's blocks). */
interface ContentBlock {
	type?: string;
	text?: string;
}

/** The minimal message shape the extractor reads (structurally an `AgentMessage`). */
export interface TailSourceMessage {
	role: string;
	content?: string | ContentBlock[] | unknown;
}

/** One replayable line: whose it was and its (already-cleaned) text. */
export interface TailMessage {
	role: "user" | "assistant";
	text: string;
}

/** How long one replayed message may be before it is truncated. */
export const TAIL_MESSAGE_MAX_LEN = 500;

/**
 * The last {@link maxMessages} user/assistant messages of a session, oldest-first, each
 * with clean text. Tool calls (assistant messages whose blocks are all `toolCall`) and
 * tool results carry no readable text and are dropped; so are empty messages. Truncation
 * keeps a single replayed post from dwarfing the topic.
 */
export function extractSessionTail(
	messages: readonly TailSourceMessage[],
	maxMessages: number,
): TailMessage[] {
	const out: TailMessage[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = cleanText(flattenText(message.content));
		if (!text) continue;
		out.push({
			role: message.role,
			text: truncate(text, TAIL_MESSAGE_MAX_LEN),
		});
	}
	return out.slice(Math.max(0, out.length - Math.max(0, maxMessages)));
}

/** Flatten a message's text so it can be read regardless of block/string shape. */
function flattenText(content: TailSourceMessage["content"]): string {
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

/** Drop the hidden Telegram-turn marker and collapse whitespace to one clean line. */
function cleanText(value: string): string {
	return value
		.split(MIXED_TELEGRAM_MARKER)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}
