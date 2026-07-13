/**
 * Make TUI text safe to render at any terminal width.
 *
 * Pi lays widgets and status lines out with fixed-width math, so a line longer than
 * the terminal — or one carrying a tab, a stray ANSI escape, or a control byte —
 * desyncs the frame: narrow the window and the layout breaks. The same defence as
 * pi-planner's chat view: sanitize the text, then clip each line to the width, with a
 * floor so an absurdly narrow terminal still gets something rather than a crash.
 *
 * Pure and unit-testable; callers pass the width in ({@link terminalWidth} reads it
 * from the process, which is the only impure part).
 */

/** Never lay out below this, however narrow the terminal claims to be. */
const MIN_WIDTH = 8;

/** The terminal's column count, with a sane default when it is not a TTY. */
export function terminalWidth(fallback = 80): number {
	const columns = process.stdout?.columns;
	return typeof columns === "number" && columns > 0 ? columns : fallback;
}

/**
 * Strip what breaks fixed-width layout: CR, tabs (a terminal renders one as 1..8
 * columns while width math counts it as 1), ANSI escapes, and other control bytes.
 */
function sanitize(text: string): string {
	// Written as escapes so the source stays ASCII-only.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte stripping
	const ansi = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte stripping
	const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
	return text
		.replace(/\r/g, "")
		.replace(/\t/g, "  ")
		.replace(ansi, "")
		.replace(control, "");
}

/** One sanitized line, clipped to `width` with an ellipsis when it does not fit. */
export function fitLine(text: string, width: number): string {
	const clean = sanitize(text);
	const limit = Math.max(MIN_WIDTH, width);
	if ([...clean].length <= limit) return clean;
	// Count by code points, so a multi-byte glyph is never cut in half.
	return `${[...clean].slice(0, limit - 1).join("")}…`;
}

/** {@link fitLine} over a widget's lines. */
export function fitLines(lines: readonly string[], width: number): string[] {
	return lines.map((line) => fitLine(line, width));
}
