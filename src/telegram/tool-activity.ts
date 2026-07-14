/**
 * Render an agent tool invocation as a collapsible Telegram rich message:
 * a one-line summary (`🔧 tool_name — <primary arg hint>`) with the full
 * parameters folded inside a `<details>` block, expanded on tap.
 *
 * This is the reusable foundation for surfacing "what the agent is doing" in
 * Telegram. It is a pure builder over {@link rich-builder} (no SDK, no grammY
 * runtime), driven by the SDK-agnostic {@link ToolCallActivity} view, so both
 * mode 1 (`tool_execution_start`) and a future mode-2 activity feed can reuse
 * it; `index.ts` maps the live `ToolExecutionStartEvent` onto this view. Result
 * rendering (a tool's output) can be added later with the same collapsible
 * pattern without changing callers.
 */
import type { InputRichMessage } from "@grammyjs/types";
import { languageForPath } from "./code-language";
import {
	bold,
	buildRichHtmlMessage,
	details,
	divider,
	inlineCode,
	italic,
	preformatted,
	RichHtml,
} from "./rich-builder";

/**
 * How the call ended. `running` is the card as first posted; the same card is then
 * edited in place to `ok` or `error`, so a chat full of wrenches tells you at a
 * glance which step failed instead of making you expand every one of them.
 *
 * `cancelled` is the card of a call that never returned — the turn was aborted
 * (/esc) under it. Without it, an interrupted card would sit there wearing the
 * running state forever, claiming work that stopped.
 */
export type ToolStatus = "running" | "ok" | "error" | "cancelled";

/** An agent tool invocation to surface in Telegram (structural, SDK-agnostic). */
export interface ToolCallActivity {
	toolName: string;
	args?: unknown;
	/** Defaults to `running` — the state a card is posted in. */
	status?: ToolStatus;
	/** The tool's output, folded into the card once it has one. */
	result?: unknown;
	/** The tool's own metadata (bash: `fullOutputPath`, truncation), when it reports any. */
	details?: unknown;
}

export interface ToolActivityOptions {
	/** Expand the parameter block by default; collapsed (false) is the norm. */
	open?: boolean;
	/** Max characters of pretty-printed args before truncation. */
	maxArgChars?: number;
	/** Longest single-line hint shown after the tool name in the summary. */
	maxHintChars?: number;
	/** Max characters of the folded result before truncation. */
	maxResultChars?: number;
	/** Override the summary's primary-argument hint (well-known tools by default). */
	describeArgs?: (activity: ToolCallActivity) => string | undefined;
}

const DEFAULT_MAX_ARG_CHARS = 3500;
const DEFAULT_MAX_HINT_CHARS = 56;
/**
 * Results are output, not input: a build log dwarfs its command, so cap it harder.
 * Exported because whoever decides to ATTACH the full output has to know exactly how
 * much of it the card is already showing — otherwise the two disagree about whether
 * anything was hidden at all.
 */
export const DEFAULT_MAX_RESULT_CHARS = 2500;

/** The status mark that trails the summary line. `running` carries none — it is the default state. */
const STATUS_MARK: Record<ToolStatus, string> = {
	running: "",
	ok: " ✅",
	error: " ❌",
	cancelled: " ⏹️",
};

/** Tools whose primary string argument is shell source, shown as a `bash` block. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "run"]);

/**
 * Tools whose OUTPUT is the file itself. Only these get the file's language applied to
 * the result: `write` answers "wrote 42 lines", and highlighting that as Rust would be
 * a lie told in colour.
 */
const READ_TOOLS = new Set(["read", "view", "cat", "open"]);

/** Argument names that carry the path of the file a tool is working on. */
const PATH_KEYS = ["file_path", "path", "filename", "file"] as const;
/** Argument names that carry the code going INTO that file. */
const NEW_CODE_KEYS = ["content", "new_string", "new_str"] as const;
/** Argument names that carry the code being replaced. */
const OLD_CODE_KEYS = ["old_string", "old_str"] as const;

function stringArg(args: unknown, keys: readonly string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * The SDK hands a tool result as `{ content: [{ type: "text", text }, …], details,
 * isError }`, not as a string. JSON-printing that whole envelope is what turned a
 * plain `find` listing into `{"content":[{"type":"text","text":".\n./.codex\n…`  —
 * the output was in there, wearing its own escaping.
 *
 * So unwrap it: concatenate the text parts, note any image part rather than
 * dumping its base64, and fall back to the raw value for anything that is not
 * shaped like a result envelope (a tool may return a bare string or an object).
 */
export function unwrapToolResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return safeJson(result);
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		const typed = part as { type?: string; text?: string };
		if (typed?.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
		} else if (typed?.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n").trim();
}

/**
 * Keep the END of a long output and say how much was dropped — a command's verdict
 * (the error, the summary, the last file) lives at the bottom, so truncating from
 * the tail is truncating away the answer. Mirrors what Pi shows in the terminal.
 */
export function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const kept = text.slice(text.length - maxChars);
	// Start at a line boundary, so the first visible line is not half a line.
	const newline = kept.indexOf("\n");
	const body = newline === -1 ? kept : kept.slice(newline + 1);
	const hidden = text.length - body.length;
	const hiddenLines = text.slice(0, hidden).split("\n").length - 1;
	const label =
		hiddenLines > 0
			? `… (${hiddenLines} earlier line${hiddenLines === 1 ? "" : "s"})`
			: "… (truncated)";
	return `${label}\n${body}`;
}

/** JSON-stringify without throwing on cycles/bigints; fall back to `String`. */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Pretty-print tool args for the folded body: a plain string is kept as-is, an
 * object is JSON-pretty-printed, and the whole thing is truncated to a cap so a
 * huge argument can't blow the message size limit.
 */
export function formatToolArgs(
	args: unknown,
	maxChars = DEFAULT_MAX_ARG_CHARS,
): string {
	if (args === undefined || args === null) return "";
	const text = typeof args === "string" ? args : safeJson(args);
	return text.length > maxChars
		? `${text.slice(0, maxChars)}\n… (truncated)`
		: text;
}

/** Collapse a hint to a single trimmed line, truncated for the summary. */
function shortHint(value: string, maxChars: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/**
 * A short hint of the salient argument for well-known tools, so the collapsed
 * summary is informative before expanding (bash → command, read/edit/write →
 * path, grep → pattern, etc.). Returns undefined when nothing obvious fits.
 */
export function defaultDescribeArgs(
	activity: ToolCallActivity,
): string | undefined {
	const args = activity.args;
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const pick = (key: string): string | undefined =>
		typeof record[key] === "string" ? (record[key] as string) : undefined;
	// A PATH is shortened; nothing else is. We know what a path means, so we know which
	// end of it carries the information — but a shell command, a regex or a URL is not
	// ours to cut, and guessing where to cut it would just be a lie in the summary line.
	const path = pick("file_path") ?? pick("path");
	if (path !== undefined) return shortenPath(path);
	return (
		pick("command") ??
		pick("pattern") ??
		pick("query") ??
		pick("url") ??
		undefined
	);
}

/**
 * `…/src/index.ts` — the end of a path, which is the part that says which file this is.
 *
 * The summary line has one line to tell you what the call did, and a full path spends it
 * on the bit that is identical in every card (`/home/you/Projects/thing/…`) — so the
 * name of the file, the only thing that differs, is what gets truncated away. The whole
 * path is still inside the card, where there is room for it.
 */
export function shortenPath(path: string): string {
	const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
	const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
	if (segments.length <= 2) return path;
	return `…${separator}${segments.slice(-2).join(separator)}`;
}

/** The single string argument of a one-key object (e.g. `{ command }`), else undefined. */
function singleStringArg(
	args: unknown,
): { key: string; value: string } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const keys = Object.keys(args as object);
	if (keys.length !== 1) return undefined;
	const value = (args as Record<string, unknown>)[keys[0]];
	return typeof value === "string" ? { key: keys[0], value } : undefined;
}

/**
 * Render the folded parameter block. A shell tool's command shows as a `bash`
 * code block; any other single string argument shows as-is (no `{"key": …}`
 * wrapper or escaped `\n`); everything else falls back to pretty JSON. This is
 * what keeps a `find … | sort | …` pipeline readable instead of a JSON blob.
 */
function renderToolBody(
	activity: ToolCallActivity,
	maxChars: number,
): RichHtml {
	const { args, toolName } = activity;
	if (typeof args === "string") {
		return preformatted(formatToolArgs(args, maxChars));
	}
	const single = singleStringArg(args);
	if (single) {
		const language = SHELL_TOOLS.has(toolName) ? "bash" : undefined;
		return preformatted(formatToolArgs(single.value, maxChars), language);
	}
	const code = renderFileEdit(args, maxChars);
	if (code) return code;
	const json = formatToolArgs(args, maxChars);
	return json ? preformatted(json, "json") : RichHtml.text("(no parameters)");
}

/**
 * A call that writes code to a file — `write`, `edit` — rendered as the code itself,
 * highlighted in the file's own language.
 *
 * As pretty JSON (the fallback) this was the worst thing on the card: the whole file
 * on one line, every newline spelled `\n`, quotes escaped, unreadable and unhighlighted.
 * The path already tells us the language (see `languageForPath`), so an edit can look
 * like the code it is. An `edit` shows both sides, labelled, because a replacement you
 * cannot see the "before" of is not a diff — it is an assertion.
 */
function renderFileEdit(args: unknown, maxChars: number): RichHtml | null {
	const path = stringArg(args, PATH_KEYS);
	const after = stringArg(args, NEW_CODE_KEYS);
	if (!path || after === undefined) return null;
	const language = languageForPath(path);
	const before = stringArg(args, OLD_CODE_KEYS);
	// Two blocks share the budget, so a huge edit cannot blow the message limit.
	const budget = before === undefined ? maxChars : Math.floor(maxChars / 2);
	const blocks: RichHtml[] = [];
	if (before !== undefined) {
		blocks.push(
			bold("Before"),
			preformatted(truncate(before, budget), language),
		);
		blocks.push(bold("After"));
	}
	blocks.push(preformatted(truncate(after, budget), language));
	return RichHtml.join(blocks);
}

/** Head-truncate a code payload — an edit reads from the top, unlike a log. */
function truncate(text: string, maxChars: number): string {
	return text.length > maxChars
		? `${text.slice(0, maxChars)}\n… (truncated)`
		: text;
}

/** Build the collapsible Rich HTML for a tool call: summary line + folded params. */
export function toolActivityHtml(
	activity: ToolCallActivity,
	options: ToolActivityOptions = {},
): RichHtml {
	const describe = options.describeArgs ?? defaultDescribeArgs;
	const rawHint = describe(activity);
	const summaryParts: RichHtml[] = [
		RichHtml.raw("🔧 "),
		inlineCode(activity.toolName),
	];
	if (rawHint) {
		summaryParts.push(
			RichHtml.raw(" — "),
			RichHtml.text(
				shortHint(rawHint, options.maxHintChars ?? DEFAULT_MAX_HINT_CHARS),
			),
		);
	}
	summaryParts.push(RichHtml.raw(STATUS_MARK[activity.status ?? "running"]));
	const summary = RichHtml.join(summaryParts);
	const blocks: RichHtml[] = [
		renderToolBody(activity, options.maxArgChars ?? DEFAULT_MAX_ARG_CHARS),
	];
	const result = renderToolResult(
		activity,
		options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
	);
	if (result) blocks.push(divider(), result);
	return details(summary, blocks, options.open ?? false);
}

/**
 * Render the tool's output under its parameters, inside the SAME folded block —
 * one card per call, not two messages. The output is UNWRAPPED from the SDK's
 * result envelope and shown as the plain text it is: a directory listing must read
 * like a listing, not like the JSON that carried it. `preformatted` escapes it, so
 * a result full of `<`, `&` or a stray `</details>` cannot break the markup around
 * it, and an empty result renders nothing at all.
 */
function renderToolResult(
	activity: ToolCallActivity,
	maxChars: number,
): RichHtml | null {
	const text = unwrapToolResult(activity.result);
	if (!text.trim()) return null;
	// A tool that answered with a structured value (not the text envelope, not a bare
	// string) is still JSON, and reads better highlighted as such.
	const structured =
		typeof activity.result === "object" &&
		activity.result !== null &&
		!Array.isArray((activity.result as { content?: unknown }).content);
	// A file that was READ comes back as itself, so it is shown as itself — highlighted
	// in its own language, which the path already told us. An error is not the file (it
	// is a message about it) and stays plain.
	const fileLanguage =
		activity.status !== "error" && READ_TOOLS.has(activity.toolName)
			? languageForPath(stringArg(activity.args, PATH_KEYS))
			: undefined;
	const blocks: RichHtml[] = [
		bold(activity.status === "error" ? "Error" : "Result"),
		preformatted(
			truncateTail(text, maxChars),
			fileLanguage ?? (structured ? "json" : undefined),
		),
	];
	// The agent's own full-output file, when the tool saved one — a truncated log is
	// only frustrating if it does not say where the rest is. The end event carries no
	// `details` of its own, so it rides inside the result envelope.
	const details =
		activity.details ??
		(activity.result as { details?: unknown } | undefined)?.details;
	const fullOutputPath = (details as { fullOutputPath?: unknown } | undefined)
		?.fullOutputPath;
	if (text.length > maxChars && typeof fullOutputPath === "string") {
		// A path on the machine running Pi, not a link: it is here so the rest of the
		// log can be asked for (`read <path>`), not tapped.
		blocks.push(
			RichHtml.join([
				italic("full output on the Pi machine: "),
				inlineCode(fullOutputPath),
			]),
		);
	}
	return RichHtml.join(blocks);
}

/**
 * The same call as one plain line — `bash — npm test` — for the streaming-draft
 * thinking placeholder, which takes text, not blocks. Shares the hint logic with
 * {@link toolActivityHtml} so the card and the live line never disagree.
 */
export function toolActivityLabel(
	activity: ToolCallActivity,
	options: ToolActivityOptions = {},
): string {
	const hint = toolActivityHint(activity, options);
	return hint ? `${activity.toolName} — ${hint}` : activity.toolName;
}

/**
 * Just the shortened argument — `npm test`, `src/index.ts` — with no tool name.
 * The thinking log prints the name itself (as code), so it needs the hint alone.
 */
export function toolActivityHint(
	activity: ToolCallActivity,
	options: ToolActivityOptions = {},
): string | undefined {
	const describe = options.describeArgs ?? defaultDescribeArgs;
	const hint = describe(activity);
	if (!hint) return undefined;
	return shortHint(hint, options.maxHintChars ?? DEFAULT_MAX_HINT_CHARS);
}

/** The tool call as a ready-to-send {@link InputRichMessage}. */
export function toolActivityMessage(
	activity: ToolCallActivity,
	options?: ToolActivityOptions,
): InputRichMessage {
	return buildRichHtmlMessage(toolActivityHtml(activity, options));
}
