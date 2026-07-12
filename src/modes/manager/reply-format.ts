/**
 * Format a manager reply for a BUSINESS chat. Business connections reject the
 * newer rich-message API (`RICH_MESSAGE_UNSUPPORTED`), so mode-2 replies go out
 * as classic Telegram messages with `parse_mode: "HTML"` instead. The labeler is
 * rendered as a blockquote so it stands clearly apart from the reply body, and
 * the hidden bot marker is appended to every chunk so the owner-account echo of
 * the message is recognised as bot-sent (not typed by the owner). Long replies
 * are split on line boundaries; only the first chunk carries the labeler.
 */
import { splitRichMarkdown } from "../../telegram/markdown";
import { escapeHtml } from "../../telegram/rich-builder";
import { BOT_MARKER } from "./identity";

/** Classic messages cap at 4096; leave room for the labeler and HTML escaping. */
const CLASSIC_MAX_CHARS = 3500;

/**
 * Build the HTML chunks for a manager reply: `[<blockquote>labeler[\nrule]</blockquote>]
 * body + marker` for the first, `body + marker` for any continuations.
 *
 * The optional `rule` is a second line inside the same blockquote (a horizontal
 * rule) that makes the bot banner taller and easier to tell apart from a message
 * the owner typed. An empty `labeler` drops the banner entirely (rule included);
 * an empty `rule` keeps just the label line.
 */
export function formatManagerReplyHtmlChunks(
	text: string,
	labeler?: string,
	rule?: string,
): string[] {
	const label = labeler?.trim();
	const ruleLine = rule?.trim();
	const banner = label
		? `<blockquote>${escapeHtml(label)}${
				ruleLine ? `\n${escapeHtml(ruleLine)}` : ""
			}</blockquote>`
		: "";
	const pieces = splitRichMarkdown(text.trim(), CLASSIC_MAX_CHARS);
	const chunks = pieces.length > 0 ? pieces : [text.trim()];
	return chunks.map((piece, index) => {
		const head = index === 0 ? banner : "";
		return `${head}${escapeHtml(piece)}${BOT_MARKER}`;
	});
}
