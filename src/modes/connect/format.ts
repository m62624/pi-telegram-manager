/**
 * House style for the mode-1 bridge's own Telegram messages.
 *
 * Control replies (/help, /commands, acknowledgements, lifecycle notices) used to
 * be flat one-liners; these helpers give them a consistent shape — a bold titled
 * header with an icon, over an optional bulleted body — so each command reads as
 * its own distinct card rather than a wall of identical lines. Output is Telegram
 * Markdown, rendered by the OutboundSender.
 */

/** A bullet body line, optionally `label — description`. */
export function bullet(label: string, description?: string): string {
	return description ? `• ${label} — ${description}` : `• ${label}`;
}

/** Italicise a short note. */
export function note(text: string): string {
	return `_${text}_`;
}

/** An inline link, `[text](url)` — rendered as a tappable link by Telegram's rich Markdown. */
export function link(text: string, url: string): string {
	return `[${text}](${url})`;
}

/**
 * A titled card: `icon **Title**`, then a blank line and the body. With no body it
 * is just the header line, so a bare acknowledgement still carries an icon and a
 * bold title. Titles use `**bold**` (Telegram's native rich Markdown flavor —
 * `*single*` would render as italic).
 */
export function card(icon: string, title: string, body: string[] = []): string {
	const header = `${icon} **${title}**`;
	return body.length > 0 ? [header, "", ...body].join("\n") : header;
}
