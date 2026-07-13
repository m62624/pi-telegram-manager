/**
 * House style for the mode-1 bridge's own Telegram messages.
 *
 * Control replies (/help, /commands, acknowledgements, lifecycle notices) used to
 * be flat one-liners; these helpers give them a consistent shape — a bold titled
 * header with an icon, over an optional bulleted body — so each command reads as
 * its own distinct card rather than a wall of identical lines. Output is Telegram
 * Markdown, rendered by the OutboundSender.
 */

/**
 * A bullet body line, optionally `label — description`.
 *
 * This is a REAL Markdown list item (`- x`), not a typed-out `•`. Telegram renders
 * our Markdown, and in Markdown a single newline is a soft break — a stack of `•`
 * lines joined by `\n` collapses into one run-on paragraph, which is exactly how
 * `/help` used to look. A list item survives the same newline as a list item.
 */
export function bullet(label: string, description?: string): string {
	return description
		? `${LIST_MARKER}${label} — ${description}`
		: `${LIST_MARKER}${label}`;
}

const LIST_MARKER = "- ";

/** Italicise a short note. */
export function note(text: string): string {
	return `_${text}_`;
}

/** An inline link, `[text](url)` — rendered as a tappable link by Telegram's rich Markdown. */
export function link(text: string, url: string): string {
	return `[${text}](${url})`;
}

/**
 * A titled card: `icon **Title**` over its body. With no body it is just the
 * header line, so a bare acknowledgement still carries an icon and a bold title.
 * Titles use `**bold**` (Telegram's native rich Markdown flavor — `*single*`
 * would render as italic).
 *
 * Blocks are separated by a BLANK line, because that is the only separator
 * Markdown honours: joined by single newlines, every line of the card ran
 * together into one paragraph. Consecutive bullets are the exception — they are
 * one list, so they keep their single newlines and render as a list. Any empty
 * strings a caller passes as hand-made spacing are dropped; the spacing is now
 * the card's own business.
 */
export function card(icon: string, title: string, body: string[] = []): string {
	const header = `${icon} **${title}**`;
	const blocks = toBlocks(body);
	return blocks.length > 0 ? [header, ...blocks].join("\n\n") : header;
}

/** Group the body into paragraph blocks, keeping a run of bullets together as one list. */
function toBlocks(body: readonly string[]): string[] {
	const blocks: string[] = [];
	let list: string[] = [];
	const flushList = (): void => {
		if (list.length === 0) return;
		blocks.push(list.join("\n"));
		list = [];
	};
	for (const line of body) {
		if (line.startsWith(LIST_MARKER)) {
			list.push(line);
			continue;
		}
		flushList();
		if (line.trim()) blocks.push(line);
	}
	flushList();
	return blocks;
}
