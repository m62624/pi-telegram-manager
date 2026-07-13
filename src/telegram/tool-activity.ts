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
import {
	bold,
	buildRichHtmlMessage,
	details,
	divider,
	inlineCode,
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
/** Results are output, not input: a build log dwarfs its command, so cap it harder. */
const DEFAULT_MAX_RESULT_CHARS = 2500;

/** The status mark that trails the summary line. `running` carries none — it is the default state. */
const STATUS_MARK: Record<ToolStatus, string> = {
	running: "",
	ok: " ✅",
	error: " ❌",
	cancelled: " ⏹️",
};

/** Tools whose primary string argument is shell source, shown as a `bash` block. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "run"]);

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
	return (
		pick("command") ??
		pick("file_path") ??
		pick("path") ??
		pick("pattern") ??
		pick("query") ??
		pick("url") ??
		undefined
	);
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
	const json = formatToolArgs(args, maxChars);
	return json ? preformatted(json, "json") : RichHtml.text("(no parameters)");
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
 * one card per call, not two messages. A string stays a string (a shell log is not
 * JSON and must not be quoted like one); anything else is pretty-printed, and both
 * are escaped by `preformatted`, so a result full of `<`, `&` or braces cannot
 * break the markup around it. An empty result renders nothing at all.
 */
function renderToolResult(
	activity: ToolCallActivity,
	maxChars: number,
): RichHtml | null {
	const { result } = activity;
	if (result === undefined || result === null) return null;
	const text = formatToolArgs(result, maxChars);
	if (!text.trim()) return null;
	const language = typeof result === "string" ? undefined : "json";
	return RichHtml.join([
		bold(activity.status === "error" ? "Error" : "Result"),
		preformatted(text, language),
	]);
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
	const describe = options.describeArgs ?? defaultDescribeArgs;
	const hint = describe(activity);
	if (!hint) return activity.toolName;
	const short = shortHint(hint, options.maxHintChars ?? DEFAULT_MAX_HINT_CHARS);
	return `${activity.toolName} — ${short}`;
}

/** The tool call as a ready-to-send {@link InputRichMessage}. */
export function toolActivityMessage(
	activity: ToolCallActivity,
	options?: ToolActivityOptions,
): InputRichMessage {
	return buildRichHtmlMessage(toolActivityHtml(activity, options));
}
