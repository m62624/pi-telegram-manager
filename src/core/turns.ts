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

export interface TurnInput {
	text?: string;
	senderName?: string;
	chatTitle?: string;
	reply?: TurnReplyContext;
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
		buildReplyLine(input.reply),
		buildAttachmentsLine(input.attachments),
		buildSavedFilesLine(input.savedFiles),
		buildAttachmentErrorsLine(input.attachmentErrors),
	]
		.filter((line) => line.length > 0)
		.join("\n");
	const body = (input.text ?? "").trim();
	return body ? `${header}\n\n${body}` : header;
}
