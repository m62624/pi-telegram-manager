/**
 * Pure building blocks for the `/resume` inline-keyboard panel — the in-chat twin
 * of the TUI session picker, letting the owner choose which session personal runs in
 * (keep the current one, start a new one, or resume any other) with a tap.
 *
 * Everything here is a pure function over structural types (no grammY runtime, no SDK),
 * so the layout, pagination, and callback parsing are unit-testable; `index.ts` wires a
 * parsed choice to the same connect-intent + session-switch path the TUI picker uses.
 */
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { SessionInfo } from "../pi/sdk";
import {
	formatSessionTime,
	sessionLabel,
	sortSessionsByRecency,
} from "../pi/session-list";

/** How many resume rows a single page shows, below the fixed Current/New rows. */
export const RESUME_PAGE_SIZE = 5;

/** The `callback_data` namespace so a press is unambiguously ours. */
const CALLBACK_PREFIX = "resume:";

/**
 * What a `/resume` button press means.
 *
 * There is no "new session" here, unlike the TUI picker: creating a session needs a Pi
 * command context, which a Telegram callback does not have (the bridge runs off a base
 * context after any switch). So the phone offers `clear` instead — a soft reset of the
 * CURRENT session — while starting a genuinely new session stays a terminal action.
 */
export type ResumeAction =
	| { kind: "current" }
	| { kind: "clear" }
	| { kind: "page"; page: number }
	| { kind: "pick"; id: string };

/** The panel's caption, above the buttons. */
export function resumePanelText(): string {
	return "Personal — pick a session:";
}

/** Whether a plain message is the `/resume` command (bare or `/resume@bot`). */
export function isResumeCommand(text: string): boolean {
	return /^\/resume(@\w+)?$/i.test(text.trim());
}

/**
 * A resume button's caption: the modified time FIRST, then the cleaned preview. Time
 * leads because a Telegram button clips its text to roughly one line — leading with the
 * stamp means every row stays distinguishable at a glance even when the preview is cut,
 * where a preview-first label would show the same truncated framing on every row.
 */
export function resumeButtonLabel(session: SessionInfo): string {
	return `${formatSessionTime(session.modified)}  ·  ${sessionLabel(session, 28)}`;
}

/** The resume rows (current session excluded, newest first) across all pages. */
function resumable(
	sessions: readonly SessionInfo[],
	currentSessionId: string,
): SessionInfo[] {
	return sortSessionsByRecency(sessions).filter(
		(session) => session.id !== currentSessionId,
	);
}

/** How many pages the resumable sessions span (at least one, even when empty). */
export function resumePageCount(
	sessions: readonly SessionInfo[],
	currentSessionId: string,
): number {
	const count = resumable(sessions, currentSessionId).length;
	return Math.max(1, Math.ceil(count / RESUME_PAGE_SIZE));
}

/**
 * Build the inline keyboard for `page` (0-based, clamped): a Current row, a New row, up
 * to {@link RESUME_PAGE_SIZE} resume rows, and a `◀ / ▶` nav row when more than one page
 * exists. Each resume button carries `resume:pick:<id>`; nav carries `resume:page:<n>`.
 */
export function buildResumeKeyboard(
	sessions: readonly SessionInfo[],
	currentSessionId: string,
	page = 0,
): InlineKeyboardMarkup {
	const rows = resumable(sessions, currentSessionId);
	const pageCount = Math.max(1, Math.ceil(rows.length / RESUME_PAGE_SIZE));
	const current = Math.min(Math.max(page, 0), pageCount - 1);
	const start = current * RESUME_PAGE_SIZE;

	const keyboard: InlineKeyboardMarkup["inline_keyboard"] = [
		[{ text: "● Current session", callback_data: `${CALLBACK_PREFIX}current` }],
		[
			{
				text: "🧹 Clear current session",
				callback_data: `${CALLBACK_PREFIX}clear`,
			},
		],
	];
	for (const session of rows.slice(start, start + RESUME_PAGE_SIZE)) {
		keyboard.push([
			{
				text: resumeButtonLabel(session),
				callback_data: `${CALLBACK_PREFIX}pick:${session.id}`,
			},
		]);
	}
	if (pageCount > 1) {
		const nav: InlineKeyboardMarkup["inline_keyboard"][number] = [];
		if (current > 0) {
			nav.push({
				text: "◀ Prev",
				callback_data: `${CALLBACK_PREFIX}page:${current - 1}`,
			});
		}
		if (current < pageCount - 1) {
			nav.push({
				text: "Next ▶",
				callback_data: `${CALLBACK_PREFIX}page:${current + 1}`,
			});
		}
		keyboard.push(nav);
	}
	return { inline_keyboard: keyboard };
}

/**
 * Parse a button press's `callback_data` into its action, or null when the data is
 * absent, malformed, or not ours — so a foreign or stale callback is ignored, not
 * misrouted. A `page:` with a non-integer, or a `pick:` with an empty id, is not ours.
 */
export function parseResumeCallback(
	data: string | undefined,
): ResumeAction | null {
	if (!data?.startsWith(CALLBACK_PREFIX)) return null;
	const rest = data.slice(CALLBACK_PREFIX.length);
	if (rest === "current") return { kind: "current" };
	if (rest === "clear") return { kind: "clear" };
	if (rest.startsWith("page:")) {
		const page = Number(rest.slice("page:".length));
		return Number.isInteger(page) && page >= 0 ? { kind: "page", page } : null;
	}
	if (rest.startsWith("pick:")) {
		const id = rest.slice("pick:".length);
		return id ? { kind: "pick", id } : null;
	}
	return null;
}
