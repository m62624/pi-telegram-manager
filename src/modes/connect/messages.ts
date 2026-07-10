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

/** A text part of a prompt turn (structurally the SDK's `TextContent`). */
export interface PromptTextPart {
	type: "text";
	text: string;
}

/** An inline image part of a prompt turn (structurally the SDK's `ImageContent`). */
export interface PromptImagePart {
	type: "image";
	/** Base64-encoded image bytes. */
	data: string;
	mimeType: string;
}

/**
 * What a prompt turn delivers to the agent: either plain text, or a mixed array
 * of image + text parts when the message carried pictures. Structurally
 * assignable to `sendUserMessage`'s `string | (TextContent | ImageContent)[]`.
 */
export type PromptContent = string | Array<PromptTextPart | PromptImagePart>;

/** A downloaded inbound image, ready to become a `PromptImagePart`. */
export interface InboundImage {
	data: string;
	mimeType: string;
}

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

/**
 * Parse a leading Telegram bot command (`/name`, `/name@bot`, `/name arg`) into
 * its lowercased name and trailing argument. Returns null when the text is not
 * a command, so ordinary messages (and prose that merely contains a slash) pass
 * through untouched.
 */
export function parseSlashCommand(
	text: string,
): { name: string; arg: string } | null {
	const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!match) return null;
	return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

/** A Pi slash command surfaced for discovery (from `pi.getCommands()`). */
export interface PiCommandInfo {
	name: string;
	description?: string;
}

/**
 * Render the registered Pi slash commands (from every loaded extension) as a
 * discovery list for Telegram. These run in the *terminal* — the SDK exposes no
 * way to execute another extension's command remotely — so the list is a
 * read-only map of what's available, sorted for a stable order.
 */
export function formatPiCommandList(
	commands: readonly PiCommandInfo[],
): string {
	if (commands.length === 0) return "No Pi commands are registered.";
	const lines = [...commands]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((command) => {
			const description = command.description
				? ` — ${command.description}`
				: "";
			return `/${command.name}${description}`;
		});
	return ["*Pi commands* (run these in the terminal):", ...lines].join("\n");
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

/** Content-part types that carry the model's private reasoning — never sent to Telegram. */
const THINKING_TYPES = new Set(["thinking", "reasoning", "redacted_thinking"]);

/**
 * Concatenate the visible text of a message's content. A plain string is used
 * verbatim; for a parts array we keep every part that has string `text` except
 * private reasoning parts, so the actual reply is captured even if the model
 * labels its text part with a non-"text" type.
 */
export function extractText(content: AgentMessageLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part) =>
				typeof part.text === "string" && !THINKING_TYPES.has(part.type ?? ""),
		)
		.map((part) => part.text)
		.join("");
}

/** The assistant's reply text from a finished message, or null when it isn't an assistant reply. */
export function assistantReplyText(message: AgentMessageLike): string | null {
	if (message.role !== "assistant") return null;
	const text = extractText(message.content).trim();
	return text.length > 0 ? text : null;
}

/**
 * The text to mirror back to Telegram from a finished agent run: the last
 * assistant message that actually has visible text. Scanning backward skips a
 * trailing empty/tool-only assistant message (which otherwise yields an empty
 * send that Telegram rejects with "rich message must be non-empty").
 */
export function lastAssistantReply(
	messages: readonly unknown[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantReplyText(messages[i] as AgentMessageLike);
		if (text) return text;
	}
	return null;
}
