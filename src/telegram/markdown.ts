/**
 * Markdown fast-path for Telegram rich messages (Bot API 10.1).
 *
 * The model writes ordinary (GitHub-flavored) Markdown. Telegram's Rich
 * Markdown is a superset of it, so we mostly pass text straight through into
 * `InputRichMessage.markdown` and let Telegram build the block tree
 * server-side. This module does two things a raw pass-through can't:
 *
 *  1. `normalizeRichMarkdown` — rewrites the LaTeX delimiters models emit
 *     (`\[ … \]`, `\( … \)`) into the `$$ … $$` / `$ … $` forms Telegram
 *     understands, but ONLY outside code (fenced blocks and inline spans), so
 *     a `\[` living in a shell/regex snippet is left untouched.
 *  2. `splitRichMarkdown` — cuts an over-long message into pieces below
 *     `RICH_MESSAGE_MAX_CHARS`. It only ever cuts on line boundaries (so inline
 *     spans like `**bold**` / `||spoiler||` / `` `code` `` — which never cross a
 *     newline — stay intact) and, when a cut lands inside a fenced code block,
 *     it closes the fence at the end of one chunk and reopens it (same
 *     language) at the top of the next, so every chunk is self-contained.
 *
 * There is no `blocks` field on `InputRichMessage`: a rich message is sent as a
 * single `markdown` (this module) or `html` (see `rich-builder.ts`) string.
 */
import type { InputRichMessage } from "@grammyjs/types";
import { normalizeCodeFences } from "./code-language";

/** Hard limits on a single Telegram rich message (Bot API 10.1). */
export const RICH_MESSAGE_MAX_CHARS = 32768;
export const RICH_MESSAGE_MAX_BLOCKS = 500;

/** A run of 3+ backticks or tildes at the start of a (possibly indented) line. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

// --- normalization ---------------------------------------------------------

interface CodeSegment {
	readonly text: string;
	/** True for fenced blocks and inline code spans, which must not be rewritten. */
	readonly code: boolean;
}

/**
 * Normalize model Markdown into Telegram Rich Markdown. Idempotent: running it
 * twice yields the same result. CRLF is collapsed to LF first so downstream
 * length math and fence detection are line-consistent.
 */
export function normalizeRichMarkdown(input: string): string {
	const text = normalizeCodeFences(input.replace(/\r\n?/g, "\n"));
	return segmentByCode(text)
		.map((segment) => (segment.code ? segment.text : rewriteMath(segment.text)))
		.join("");
}

/** Rewrite LaTeX delimiters in a plain (non-code) span. */
function rewriteMath(plain: string): string {
	return plain
		.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
		.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);
}

/** Split text into alternating plain / code segments (fenced blocks + inline code). */
function segmentByCode(text: string): CodeSegment[] {
	const segments: CodeSegment[] = [];
	let plainStart = 0;
	let i = 0;
	const pushPlain = (end: number): void => {
		if (end > plainStart) {
			segments.push({ text: text.slice(plainStart, end), code: false });
		}
	};
	while (i < text.length) {
		const atLineStart = i === 0 || text[i - 1] === "\n";
		if (atLineStart) {
			const marker = fenceMarkerAt(text, i);
			if (marker) {
				pushPlain(i);
				const end = fenceBlockEnd(text, i, marker);
				segments.push({ text: text.slice(i, end), code: true });
				plainStart = end;
				i = end;
				continue;
			}
		}
		if (text[i] === "`") {
			const run = runLength(text, i, "`");
			const close = inlineCodeClose(text, i + run, run);
			if (close !== -1) {
				pushPlain(i);
				const end = close + run;
				segments.push({ text: text.slice(i, end), code: true });
				plainStart = end;
				i = end;
				continue;
			}
		}
		i++;
	}
	pushPlain(text.length);
	return segments;
}

/** The fence marker (e.g. "```") if a fenced block opens on the line at `i`, else null. */
function fenceMarkerAt(text: string, i: number): string | null {
	const line = text.slice(i, lineEnd(text, i));
	const match = line.match(FENCE_OPEN);
	return match ? match[1] : null;
}

/** Index just past a fenced block opened at `openStart`. Unterminated blocks run to EOF. */
function fenceBlockEnd(
	text: string,
	openStart: number,
	marker: string,
): number {
	const fenceChar = marker[0] === "`" ? "`" : "~";
	const close = new RegExp(`^\\s*${fenceChar}{${marker.length},}\\s*$`);
	let cursor = lineEnd(text, openStart);
	while (cursor < text.length) {
		cursor += 1; // step over the newline
		const stop = lineEnd(text, cursor);
		if (close.test(text.slice(cursor, stop))) {
			return stop < text.length ? stop + 1 : stop;
		}
		cursor = stop;
	}
	return text.length;
}

/** Index of a backtick run of exactly `run` length closing an inline span, or -1. */
function inlineCodeClose(text: string, from: number, run: number): number {
	let i = from;
	while (i < text.length) {
		if (text[i] === "`") {
			const here = runLength(text, i, "`");
			if (here === run) return i;
			i += here;
			continue;
		}
		i++;
	}
	return -1;
}

function runLength(text: string, i: number, char: string): number {
	let n = 0;
	while (i + n < text.length && text[i + n] === char) n++;
	return n;
}

function lineEnd(text: string, from: number): number {
	const nl = text.indexOf("\n", from);
	return nl === -1 ? text.length : nl;
}

// --- splitting -------------------------------------------------------------

/**
 * Split rich Markdown into chunks no longer than `max` characters, cutting only
 * on line boundaries and preserving fenced code blocks across cuts (close +
 * reopen with the same language). A single line longer than `max` is a
 * degenerate case and is hard-split by characters as a last resort.
 *
 * Length is measured in UTF-16 code units, a conservative bound on Telegram's
 * UTF-8 character limit (code units >= code points), so the limit is never
 * exceeded.
 */
export function splitRichMarkdown(
	text: string,
	max = RICH_MESSAGE_MAX_CHARS,
): string[] {
	if (max <= 0) throw new RangeError("max must be a positive number");
	if (text.length <= max) return [text];

	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;
	/** The opening fence line (with language) to reopen after a cut, or null. */
	let openFenceHeader: string | null = null;
	/** The bare fence token (e.g. "```") used to close a reopened fence. */
	let openFenceToken = "";

	const flush = (): void => {
		if (current.length === 0) return;
		const closing =
			openFenceHeader !== null ? [...current, openFenceToken] : current;
		chunks.push(closing.join("\n"));
		current = [];
		currentLen = 0;
		if (openFenceHeader !== null) {
			current.push(openFenceHeader);
			currentLen = openFenceHeader.length;
		}
	};

	for (const line of text.split("\n")) {
		const joinCost = current.length > 0 ? 1 : 0; // the "\n" that would precede this line
		const onlyReopenedHeader = openFenceHeader !== null && current.length === 1;
		if (
			currentLen + joinCost + line.length > max &&
			current.length > 0 &&
			!onlyReopenedHeader
		) {
			flush();
		}
		currentLen += (current.length > 0 ? 1 : 0) + line.length;
		current.push(line);

		const opener = line.match(FENCE_OPEN);
		if (openFenceHeader === null && opener) {
			openFenceHeader = line;
			openFenceToken = opener[1];
		} else if (openFenceHeader !== null && isFenceClose(line, openFenceToken)) {
			openFenceHeader = null;
			openFenceToken = "";
		}
	}
	flush();

	return chunks.flatMap((chunk) =>
		chunk.length <= max ? [chunk] : hardSplit(chunk, max),
	);
}

function isFenceClose(line: string, token: string): boolean {
	const fenceChar = token[0] === "`" ? "`" : "~";
	return new RegExp(`^\\s*${fenceChar}{${token.length},}\\s*$`).test(line);
}

function hardSplit(text: string, max: number): string[] {
	const pieces: string[] = [];
	for (let i = 0; i < text.length; i += max) {
		pieces.push(text.slice(i, i + max));
	}
	return pieces;
}

// --- assembly --------------------------------------------------------------

/**
 * Wrap an already-normalized Markdown string as a single rich message. We set
 * `skip_entity_detection` (matching the pi-telegram reference) so Telegram
 * renders our markdown as-is instead of also auto-detecting URLs/mentions.
 */
export function buildRichMarkdownMessage(markdown: string): InputRichMessage {
	return { markdown, skip_entity_detection: true };
}

/** Full pipeline: normalize model Markdown, then split into sendable rich messages. */
export function toRichMarkdownMessages(
	rawMarkdown: string,
): InputRichMessage[] {
	const normalized = normalizeRichMarkdown(rawMarkdown);
	return splitRichMarkdown(normalized).map((markdown) => ({
		markdown,
		skip_entity_detection: true,
	}));
}
