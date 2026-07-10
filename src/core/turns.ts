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

export interface TurnInput {
	text?: string;
	senderName?: string;
	chatTitle?: string;
	reply?: TurnReplyContext;
	attachments?: readonly TurnAttachment[];
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

/** Build the full prompt-turn text: header lines, a blank line, then the body. */
export function buildPromptTurn(input: TurnInput): string {
	const header = [
		buildHeader(input),
		buildReplyLine(input.reply),
		buildAttachmentsLine(input.attachments),
	]
		.filter((line) => line.length > 0)
		.join("\n");
	const body = (input.text ?? "").trim();
	return body ? `${header}\n\n${body}` : header;
}
