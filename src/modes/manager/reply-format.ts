/**
 * Format a manager reply for a BUSINESS chat. Business connections reject the
 * newer rich-message API (`RICH_MESSAGE_UNSUPPORTED`) and cannot use it with a
 * real person, so mode-2 replies go out as classic Telegram messages with
 * `parse_mode: "HTML"` instead.
 *
 * The model writes GitHub-flavored Markdown; `telegram-markdown-formatter`
 * converts it to the HTML subset Telegram accepts (bold/italic/code/pre/quote/
 * links), leaving code spans verbatim — so a reply reads as formatted text, not
 * raw `**` punctuation. The labeler is rendered as a blockquote so it stands
 * apart from a message the owner typed, and the hidden bot marker is appended to
 * every chunk so the owner-account echo is recognised as bot-sent. Long replies
 * are split (HTML-aware) by the same library; only the first chunk carries the
 * labeler.
 */
import {
	splitHtmlForTelegram,
	telegramFormat,
} from "telegram-markdown-formatter";
import { normalizeCodeFences } from "../../telegram/code-language";
import { escapeHtml } from "../../telegram/rich-builder";
import { BOT_MARKER } from "./identity";

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
	// Fix the language tag BEFORE the Markdown becomes HTML: the formatter copies the
	// fence's word into `class="language-…"` verbatim, and Telegram highlights nothing
	// it does not recognise — so a model writing ```rs got no colour at all.
	const html = telegramFormat(normalizeCodeFences(text.trim()));
	const pieces = splitHtmlForTelegram(html);
	const chunks = pieces.length > 0 ? pieces : [html];
	return chunks.map((piece, index) => {
		const head = index === 0 ? banner : "";
		return `${head}${piece}${BOT_MARKER}`;
	});
}
