/**
 * Structured builder for Telegram rich messages we assemble ourselves (Bot API
 * 10.1) — collapsible code diffs, tables from data, banners — rather than
 * passing model prose through the Markdown fast-path (`markdown.ts`).
 *
 * A rich message is sent as an `InputRichMessage.html` string, so this is a
 * typed builder over Telegram's Rich HTML dialect. It never emits a raw
 * `RichBlock[]` tree — `InputRichMessage` has no such field; HTML is the second
 * (and strictly more expressive) input channel, giving us `<details>`,
 * `<table>`, `<sub>/<sup>`, `<tg-spoiler>`, and `<tg-math-block>`.
 *
 * Escaping is handled by the {@link RichHtml} wrapper: a plain `string` passed
 * anywhere is treated as text and HTML-escaped exactly once; a `RichHtml`
 * value is already-built markup and is passed through untouched. This makes
 * nesting (bold → code → spoiler) safe without double-escaping.
 */
import type { InputRichMessage } from "@grammyjs/types";

/** The named HTML entities Telegram accepts are limited; we only ever emit these three. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * A piece of already-built, escape-safe Rich HTML. Construct it from trusted
 * text with {@link RichHtml.text} (escaped) or {@link RichHtml.raw} (verbatim).
 * `RichHtml.of` accepts either a plain string (escaped as text) or a `RichHtml`
 * (passed through), which is how every builder below accepts nestable content.
 */
export class RichHtml {
	private constructor(readonly html: string) {}

	/** Escape plain text into safe inline HTML. */
	static text(value: string): RichHtml {
		return new RichHtml(escapeHtml(value));
	}

	/** Wrap an already-valid Rich HTML fragment without escaping it. */
	static raw(html: string): RichHtml {
		return new RichHtml(html);
	}

	/** Normalize content: strings are escaped as text, `RichHtml` is passed through. */
	static of(value: RichContent): RichHtml {
		return value instanceof RichHtml ? value : RichHtml.text(value);
	}

	/** Concatenate mixed content into one fragment. */
	static join(parts: readonly RichContent[]): RichHtml {
		return RichHtml.raw(parts.map((part) => RichHtml.of(part).html).join(""));
	}

	toString(): string {
		return this.html;
	}
}

/** Anything a builder accepts as content: raw text (escaped) or built HTML. */
export type RichContent = RichHtml | string;

/** Heading level, largest (1) to smallest (6). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

// --- inline formatting -----------------------------------------------------

function inline(tag: string, content: RichContent): RichHtml {
	return RichHtml.raw(`<${tag}>${RichHtml.of(content).html}</${tag}>`);
}

export const bold = (content: RichContent): RichHtml => inline("b", content);
export const italic = (content: RichContent): RichHtml => inline("i", content);
export const underline = (content: RichContent): RichHtml =>
	inline("u", content);
export const strikethrough = (content: RichContent): RichHtml =>
	inline("s", content);
export const inlineCode = (content: RichContent): RichHtml =>
	inline("code", content);
export const marked = (content: RichContent): RichHtml =>
	inline("mark", content);
export const spoiler = (content: RichContent): RichHtml =>
	inline("tg-spoiler", content);
export const subscript = (content: RichContent): RichHtml =>
	inline("sub", content);
export const superscript = (content: RichContent): RichHtml =>
	inline("sup", content);

/** Inline LaTeX (`<tg-math>`). The source is raw LaTeX; we only HTML-escape it. */
export const mathInline = (latex: string): RichHtml =>
	RichHtml.raw(`<tg-math>${escapeHtml(latex)}</tg-math>`);

export function link(text: RichContent, url: string): RichHtml {
	return RichHtml.raw(
		`<a href="${escapeAttr(url)}">${RichHtml.of(text).html}</a>`,
	);
}

// --- block formatting ------------------------------------------------------

export const heading = (text: RichContent, level: HeadingLevel = 2): RichHtml =>
	RichHtml.raw(`<h${level}>${RichHtml.of(text).html}</h${level}>`);

export const paragraph = (text: RichContent): RichHtml =>
	RichHtml.raw(`<p>${RichHtml.of(text).html}</p>`);

export const footer = (text: RichContent): RichHtml =>
	RichHtml.raw(`<footer>${RichHtml.of(text).html}</footer>`);

export const divider = (): RichHtml => RichHtml.raw("<hr/>");

/** Multi-line LaTeX block (`<tg-math-block>`). */
export const mathBlock = (latex: string): RichHtml =>
	RichHtml.raw(`<tg-math-block>${escapeHtml(latex)}</tg-math-block>`);

/** A preformatted code block, optionally tagged with a programming language. */
export function preformatted(code: string, language?: string): RichHtml {
	const body = escapeHtml(code);
	if (language) {
		return RichHtml.raw(
			`<pre><code class="language-${escapeAttr(language)}">${body}</code></pre>`,
		);
	}
	return RichHtml.raw(`<pre>${body}</pre>`);
}

/** A collapsible disclosure block (`<details>`); `open` shows it expanded. */
export function details(
	summary: RichContent,
	content: readonly RichContent[],
	open = false,
): RichHtml {
	const inner = content.map((part) => RichHtml.of(part).html).join("");
	const attr = open ? " open" : "";
	return RichHtml.raw(
		`<details${attr}><summary>${RichHtml.of(summary).html}</summary>${inner}</details>`,
	);
}

export interface CollapsibleCodeOptions {
	/** Always-visible label; defaults to `"<language> (<n> lines)"`. */
	summary?: RichContent;
	language?: string;
	/** Expand by default. Collapsed (false) is the norm for long diffs. */
	open?: boolean;
}

/**
 * A collapsible code/diff block: a `<details>` wrapping a `<pre><code>`. Long
 * diffs stay folded by default so they don't dominate a message, and expand on
 * tap. This is the collapsible-diff rendering the plan calls for.
 */
export function collapsibleCode(
	code: string,
	options: CollapsibleCodeOptions = {},
): RichHtml {
	const lineCount = code.split("\n").length;
	const summary =
		options.summary ?? `${options.language ?? "code"} (${lineCount} lines)`;
	return details(
		summary,
		[preformatted(code, options.language)],
		options.open ?? false,
	);
}

export function blockquote(
	content: readonly RichContent[],
	credit?: RichContent,
): RichHtml {
	const inner = content.map((part) => RichHtml.of(part).html).join("");
	const cite =
		credit === undefined ? "" : `<cite>${RichHtml.of(credit).html}</cite>`;
	return RichHtml.raw(`<blockquote>${inner}${cite}</blockquote>`);
}

/** A centered pull quote (`<aside>`). */
export function pullQuote(text: RichContent, credit?: RichContent): RichHtml {
	const cite =
		credit === undefined ? "" : `<cite>${RichHtml.of(credit).html}</cite>`;
	return RichHtml.raw(`<aside>${RichHtml.of(text).html}${cite}</aside>`);
}

export interface ListItem {
	text: RichContent;
	/** Render a checkbox before the item. */
	checkbox?: boolean;
	/** Tick the checkbox (implies `checkbox`). */
	checked?: boolean;
}

export interface ListOptions {
	ordered?: boolean;
	/** First number of an ordered list. */
	start?: number;
}

export function list(
	items: readonly (RichContent | ListItem)[],
	options: ListOptions = {},
): RichHtml {
	const tag = options.ordered ? "ol" : "ul";
	const start =
		options.ordered && options.start !== undefined
			? ` start="${options.start}"`
			: "";
	const body = items
		.map((item) => {
			if (isListItem(item)) {
				const withBox = item.checkbox || item.checked;
				const box = withBox
					? `<input type="checkbox"${item.checked ? " checked" : ""}>`
					: "";
				return `<li>${box}${RichHtml.of(item.text).html}</li>`;
			}
			return `<li>${RichHtml.of(item).html}</li>`;
		})
		.join("");
	return RichHtml.raw(`<${tag}${start}>${body}</${tag}>`);
}

function isListItem(value: RichContent | ListItem): value is ListItem {
	return (
		typeof value === "object" && !(value instanceof RichHtml) && "text" in value
	);
}

export interface TableCell {
	text?: RichContent;
	header?: boolean;
	align?: "left" | "center" | "right";
	valign?: "top" | "middle" | "bottom";
	colspan?: number;
	rowspan?: number;
}

export interface TableOptions {
	bordered?: boolean;
	striped?: boolean;
	caption?: RichContent;
}

export function table(
	rows: readonly (readonly TableCell[])[],
	options: TableOptions = {},
): RichHtml {
	const attrs = `${options.bordered ? " bordered" : ""}${options.striped ? " striped" : ""}`;
	const caption =
		options.caption === undefined
			? ""
			: `<caption>${RichHtml.of(options.caption).html}</caption>`;
	const body = rows
		.map((row) => {
			const cells = row.map((cell) => renderCell(cell)).join("");
			return `<tr>${cells}</tr>`;
		})
		.join("");
	return RichHtml.raw(`<table${attrs}>${caption}${body}</table>`);
}

function renderCell(cell: TableCell): string {
	const tag = cell.header ? "th" : "td";
	const align = cell.align ? ` align="${cell.align}"` : "";
	const valign = cell.valign ? ` valign="${cell.valign}"` : "";
	const colspan =
		cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
	const rowspan =
		cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
	const content = cell.text === undefined ? "" : RichHtml.of(cell.text).html;
	return `<${tag}${align}${valign}${colspan}${rowspan}>${content}</${tag}>`;
}

// --- document --------------------------------------------------------------

/**
 * Fluent accumulator for a whole rich message. Each method appends a block and
 * returns `this`; `build()` produces the `InputRichMessage`. Plain strings
 * passed to `add`/`paragraph`/… are escaped as text.
 */
export class RichHtmlDocument {
	private readonly blocks: string[] = [];

	add(block: RichContent): this {
		this.blocks.push(RichHtml.of(block).html);
		return this;
	}

	heading(text: RichContent, level?: HeadingLevel): this {
		return this.add(heading(text, level));
	}

	paragraph(text: RichContent): this {
		return this.add(paragraph(text));
	}

	code(code: string, language?: string): this {
		return this.add(preformatted(code, language));
	}

	collapsibleCode(code: string, options?: CollapsibleCodeOptions): this {
		return this.add(collapsibleCode(code, options));
	}

	table(rows: readonly (readonly TableCell[])[], options?: TableOptions): this {
		return this.add(table(rows, options));
	}

	divider(): this {
		return this.add(divider());
	}

	isEmpty(): boolean {
		return this.blocks.length === 0;
	}

	toHtml(): string {
		return this.blocks.join("\n");
	}

	build(): InputRichMessage {
		return { html: this.toHtml() };
	}
}

/** Wrap an already-built Rich HTML string as a rich message. */
export function buildRichHtmlMessage(html: RichContent): InputRichMessage {
	return { html: RichHtml.of(html).html };
}
