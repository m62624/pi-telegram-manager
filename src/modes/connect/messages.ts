/**
 * Pure translation layer for mode 1 (terminal continuation), in both
 * directions:
 *
 *  - inbound:  a Telegram `Message` → a `TurnInput` for `buildPromptTurn`
 *    (sender name, reply quote, attachment descriptors via `describeAttachments`);
 *  - outbound: a finished agent `AgentMessage` → the assistant's reply text to
 *    send back.
 *
 * Both are pure and structurally typed (no SDK, no grammY runtime), so the
 * controller's data mapping is unit-testable; the controller itself only does
 * the event wiring and sending.
 */
import type { Message, User } from "@grammyjs/types";
import type { TurnInput } from "../../core/turns";
import { describeAttachments } from "../../telegram/media";

/** A person's display name: full name if present, else @username, else a fallback. */
export function senderDisplayName(from: User | undefined): string | undefined {
	if (!from) return undefined;
	const full = [from.first_name, from.last_name]
		.filter(Boolean)
		.join(" ")
		.trim();
	if (full) return full;
	return from.username ? `@${from.username}` : undefined;
}

/** The text a message carries — its body or a media caption. */
export function messageText(message: Message): string {
	return message.text ?? message.caption ?? "";
}

/** Map a Telegram message to the prompt-turn input (sender, reply, attachments). */
export function messageToTurnInput(
	message: Message,
	maxBytes?: number,
): TurnInput {
	const attachments = describeAttachments(message, maxBytes).map((ref) => ({
		kind: ref.kind,
		fileName: ref.fileName,
		mimeType: ref.mimeType,
	}));
	const replyTo = message.reply_to_message;
	const reply = replyTo
		? { author: senderDisplayName(replyTo.from), text: messageText(replyTo) }
		: undefined;
	return {
		text: messageText(message),
		senderName: senderDisplayName(message.from),
		reply,
		attachments: attachments.length > 0 ? attachments : undefined,
	};
}

/** Structural view of an agent message — just what reply extraction needs. */
interface AgentMessageLike {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

/** Concatenate the text parts of a message's content. */
export function extractText(content: AgentMessageLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** The assistant's reply text from a finished message, or null when it isn't an assistant reply. */
export function assistantReplyText(message: AgentMessageLike): string | null {
	if (message.role !== "assistant") return null;
	const text = extractText(message.content).trim();
	return text.length > 0 ? text : null;
}
