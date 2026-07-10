/**
 * Assemble the text of a single prompt turn from an incoming Telegram message.
 *
 * The model needs to know, in-band, who wrote, in which chat, what they were
 * replying to, and which files rode along — none of which is part of the raw
 * message text. We prepend compact, deterministic header lines:
 *
 *   [telegram|from:Alice|chat:General]
 *   [reply to Bob]: "earlier text…"
 *   [attachments: photo, document "report.pdf"]
 *
 *   <the message body>
 *
 * This is a pure string builder (no grammY, no I/O), so it is fully unit
 * tested. Attribute values are sanitized so a stray `|`/`]`/newline can't break
 * the header framing, and long reply quotes are truncated.
 */

/** Marker word for the header line; mirrors pi-telegram's `[telegram|…]` convention. */
export const TELEGRAM_PREFIX = "telegram";

/** Longest reply quote we inline before truncating with an ellipsis. */
export const REPLY_QUOTE_MAX = 200;

export interface TurnReplyContext {
	author?: string;
	text: string;
}

/**
 * Cross-cutting context a Telegram message carries about *other* messages:
 * whether it was forwarded, what it replies to (same chat), a quoted excerpt,
 * or a reply to a message in another chat. Extracted once from the raw message
 * (see `telegram/message-context.ts`) and rendered the same way in both modes,
 * so the model always has the full picture regardless of which mode is active.
 */
export interface MessageContext {
	/** Original sender when the message was forwarded, e.g. `channel «News»`. */
	forwardedFrom?: string;
	/** The message being replied to in the same chat (whole text). */
	reply?: TurnReplyContext;
	/** The specific excerpt the sender quoted from the replied message. */
	quote?: string;
	/** A reply to a message from another chat, e.g. `a photo from channel «News»`. */
	externalReply?: string;
	/** True when the message replies to a story. */
	replyToStory?: boolean;
}

export interface TurnAttachment {
	kind: string;
	fileName?: string;
	mimeType?: string;
}

/** A file saved to disk from an inbound message, surfaced to the model. */
export interface TurnSavedFile {
	path: string;
	kind: string;
	/** Human-readable size, e.g. "1.2 MB". */
	size?: string;
	mimeType?: string;
}

export interface TurnInput extends MessageContext {
	text?: string;
	senderName?: string;
	chatTitle?: string;
	attachments?: readonly TurnAttachment[];
	/** Non-image files saved to disk, with their absolute paths. */
	savedFiles?: readonly TurnSavedFile[];
	/** Human-readable errors for attachments that could not be downloaded/saved. */
	attachmentErrors?: readonly string[];
}

/** Strip the characters that would break header framing, collapsing whitespace. */
function sanitizeAttribute(value: string): string {
	return value
		.replace(/[|\]\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** The `[telegram|from:…|chat:…]` header, omitting absent attributes. */
export function buildHeader(input: TurnInput): string {
	const parts = [TELEGRAM_PREFIX];
	const from = input.senderName ? sanitizeAttribute(input.senderName) : "";
	const chat = input.chatTitle ? sanitizeAttribute(input.chatTitle) : "";
	if (from) parts.push(`from:${from}`);
	if (chat) parts.push(`chat:${chat}`);
	return `[${parts.join("|")}]`;
}

/** The `[reply to X]: "quote"` line, or empty when there is no reply. */
export function buildReplyLine(reply: TurnReplyContext | undefined): string {
	if (!reply) return "";
	const quote = truncate(reply.text, REPLY_QUOTE_MAX);
	const author = reply.author ? sanitizeAttribute(reply.author) : "";
	return author ? `[reply to ${author}]: "${quote}"` : `[reply]: "${quote}"`;
}

/** The `[forwarded from: X]` line, or empty when the message is not a forward. */
export function buildForwardLine(forwardedFrom: string | undefined): string {
	if (!forwardedFrom) return "";
	return `[forwarded from: ${sanitizeAttribute(forwardedFrom)}]`;
}

/** The `[quoting]: "excerpt"` line for a partial quote, or empty. */
export function buildQuoteLine(quote: string | undefined): string {
	if (!quote?.trim()) return "";
	return `[quoting]: "${truncate(quote, REPLY_QUOTE_MAX)}"`;
}

/** The `[replying to: a photo from channel X]` line for a cross-chat reply, or empty. */
export function buildExternalReplyLine(
	externalReply: string | undefined,
): string {
	if (!externalReply) return "";
	return `[replying to: ${sanitizeAttribute(externalReply)}]`;
}

/**
 * The cross-message context lines (forward origin, reply, partial quote,
 * cross-chat reply, story reply), in a stable order. Shared by both modes so a
 * forwarded/replied/quoted message reads the same everywhere.
 */
export function buildContextLines(ctx: MessageContext): string[] {
	return [
		buildForwardLine(ctx.forwardedFrom),
		buildReplyLine(ctx.reply),
		buildQuoteLine(ctx.quote),
		buildExternalReplyLine(ctx.externalReply),
		ctx.replyToStory ? "[replying to a story]" : "",
	].filter((line) => line.length > 0);
}

/** The `[attachments: …]` line, or empty when there are none. */
export function buildAttachmentsLine(
	attachments: readonly TurnAttachment[] | undefined,
): string {
	if (!attachments || attachments.length === 0) return "";
	const items = attachments.map((att) => {
		const name = att.fileName ? sanitizeAttribute(att.fileName) : "";
		return name ? `${att.kind} "${name}"` : att.kind;
	});
	return `[attachments: ${items.join(", ")}]`;
}

/**
 * The `[saved files: …]` line listing absolute paths of files written to disk,
 * so the model can open them with its normal tools. Empty when none.
 */
export function buildSavedFilesLine(
	savedFiles: readonly TurnSavedFile[] | undefined,
): string {
	if (!savedFiles || savedFiles.length === 0) return "";
	const items = savedFiles.map((file) => {
		const meta = [file.size, file.mimeType].filter(Boolean).join(", ");
		return meta ? `${file.path} (${meta})` : file.path;
	});
	return `[saved files: ${items.join("; ")}]`;
}

/** The `[attachment errors: …]` line, or empty when there are none. */
export function buildAttachmentErrorsLine(
	errors: readonly string[] | undefined,
): string {
	if (!errors || errors.length === 0) return "";
	return `[attachment errors: ${errors.map((e) => sanitizeAttribute(e)).join("; ")}]`;
}

/** Build the full prompt-turn text: header lines, a blank line, then the body. */
export function buildPromptTurn(input: TurnInput): string {
	const header = [
		buildHeader(input),
		...buildContextLines(input),
		buildAttachmentsLine(input.attachments),
		buildSavedFilesLine(input.savedFiles),
		buildAttachmentErrorsLine(input.attachmentErrors),
	]
		.filter((line) => line.length > 0)
		.join("\n");
	const body = (input.text ?? "").trim();
	return body ? `${header}\n\n${body}` : header;
}
