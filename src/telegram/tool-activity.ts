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
	buildRichHtmlMessage,
	details,
	inlineCode,
	preformatted,
	RichHtml,
} from "./rich-builder";

/** An agent tool invocation to surface in Telegram (structural, SDK-agnostic). */
export interface ToolCallActivity {
	toolName: string;
	args?: unknown;
}

export interface ToolActivityOptions {
	/** Expand the parameter block by default; collapsed (false) is the norm. */
	open?: boolean;
	/** Max characters of pretty-printed args before truncation. */
	maxArgChars?: number;
	/** Longest single-line hint shown after the tool name in the summary. */
	maxHintChars?: number;
	/** Override the summary's primary-argument hint (well-known tools by default). */
	describeArgs?: (activity: ToolCallActivity) => string | undefined;
}

const DEFAULT_MAX_ARG_CHARS = 3500;
const DEFAULT_MAX_HINT_CHARS = 80;

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
	const summary = RichHtml.join(summaryParts);
	const body = formatToolArgs(activity.args, options.maxArgChars);
	const content: RichHtml[] = body
		? [preformatted(body, "json")]
		: [RichHtml.text("(no parameters)")];
	return details(summary, content, options.open ?? false);
}

/** The tool call as a ready-to-send {@link InputRichMessage}. */
export function toolActivityMessage(
	activity: ToolCallActivity,
	options?: ToolActivityOptions,
): InputRichMessage {
	return buildRichHtmlMessage(toolActivityHtml(activity, options));
}
