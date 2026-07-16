/**
 * Listing the Pi sessions of a project directory, for the personal session picker
 * (TUI `ctx.ui.select` and the Telegram `/resume` panel).
 *
 * The SDK already does the heavy lifting: `SessionManager.list(cwd)` reads the session
 * files for a cwd and returns a `SessionInfo` per session — path, id, a first-message
 * preview, timestamps, and a message count. So there is no jsonl parsing here; this
 * module is only the thin, pure shaping the picker needs (recency order, an "empty"
 * predicate, a truncated one-line label), kept separate so it is unit-testable on plain
 * `SessionInfo` fakes without touching the filesystem.
 */
import { type SessionInfo, SessionManager } from "./sdk";

/** Every session recorded for `cwd`, newest first. Thin wrapper over the SDK lister. */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
	return sortSessionsByRecency(await SessionManager.list(cwd));
}

/** Newest first, by last-modified time. Copies rather than sorting in place. */
export function sortSessionsByRecency<T extends { modified: Date }>(
	sessions: readonly T[],
): T[] {
	return [...sessions].sort(
		(a, b) => b.modified.getTime() - a.modified.getTime(),
	);
}

/**
 * Whether a session holds no conversation yet — i.e. picking "New" would land the owner
 * in one just like it. `messageCount` counts user/assistant turns, so a bare session
 * (only its header) is 0.
 */
export function isSessionEmpty(
	info: Pick<SessionInfo, "messageCount">,
): boolean {
	return info.messageCount === 0;
}

/**
 * A one-line label for a picker row: the session's display name if it has one, else its
 * first message as a preview, else a placeholder — whitespace-collapsed and truncated so
 * it never blows out a Telegram inline button (the TUI selector wraps on its own, but the
 * same cap is harmless there).
 */
export function sessionLabel(
	info: Pick<SessionInfo, "name" | "firstMessage" | "messageCount">,
	maxLen = 48,
): string {
	const base =
		nonEmpty(info.name) ??
		nonEmpty(info.firstMessage) ??
		(info.messageCount === 0 ? "(empty session)" : "(no preview)");
	return truncate(collapseWhitespace(base), maxLen);
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** What the owner chose in the session picker. */
export type SessionPick =
	| { kind: "current" }
	| { kind: "new" }
	| { kind: "resume"; path: string }
	| { kind: "page"; page: number };

/** One picker row: the text shown, and the choice it stands for. */
export interface SessionPickerOption {
	label: string;
	pick: SessionPick;
}

const CURRENT_LABEL = "● Current session";
const NEW_LABEL = "＋ New session";
const OLDER_LABEL = "▽  Older sessions";
const NEWER_LABEL = "△  Newer sessions";

/**
 * How many resume rows one page of the TUI picker shows, below the fixed Current/New
 * rows. The SDK's `ui.select` renders a flat list with no scrollback, so an unbounded
 * roster of a busy project scrolls its own top off-screen; paging keeps every page short
 * enough to read whole. The Telegram panel pages separately (see resume-panel.ts).
 */
export const SESSION_PICKER_PAGE_SIZE = 8;

/** How many pages the resumable sessions span (at least one, even when empty). */
export function sessionPickerPageCount(
	sessions: readonly SessionInfo[],
	currentSessionId: string,
): number {
	const count = sessions.filter((s) => s.id !== currentSessionId).length;
	return Math.max(1, Math.ceil(count / SESSION_PICKER_PAGE_SIZE));
}

/**
 * The rows for one page of the personal session picker: keep the current session, start a
 * new one, or resume one of the project's others (newest first, the current one skipped
 * since it is already the first row). Each resume row carries a last-modified stamp — a
 * friendly cue AND what keeps two rows with the same preview apart, so a selection
 * resolves back to exactly one session. When the roster spans more than one page, a
 * `▽ Older` / `△ Newer` row is added; selecting it re-opens the picker on that page rather
 * than choosing a session, so a long history stays navigable in a scrollback-less select.
 */
export function buildSessionPickerOptions(
	sessions: readonly SessionInfo[],
	currentSessionId: string,
	page = 0,
): SessionPickerOption[] {
	const resumable = sortSessionsByRecency(sessions).filter(
		(session) => session.id !== currentSessionId,
	);
	const pageCount = Math.max(
		1,
		Math.ceil(resumable.length / SESSION_PICKER_PAGE_SIZE),
	);
	const current = Math.min(Math.max(page, 0), pageCount - 1);
	const start = current * SESSION_PICKER_PAGE_SIZE;

	const options: SessionPickerOption[] = [
		{ label: CURRENT_LABEL, pick: { kind: "current" } },
		{ label: NEW_LABEL, pick: { kind: "new" } },
	];
	for (const session of resumable.slice(
		start,
		start + SESSION_PICKER_PAGE_SIZE,
	)) {
		options.push({
			label: `${sessionLabel(session, 44)}  ·  ${formatSessionTime(session.modified)}`,
			pick: { kind: "resume", path: session.path },
		});
	}
	if (current > 0) {
		options.push({
			label: NEWER_LABEL,
			pick: { kind: "page", page: current - 1 },
		});
	}
	if (current < pageCount - 1) {
		options.push({
			label: OLDER_LABEL,
			pick: { kind: "page", page: current + 1 },
		});
	}
	return options;
}

/** Map the label the selector returned back to its choice (null if it matches none). */
export function resolveSessionPick(
	options: readonly SessionPickerOption[],
	selectedLabel: string,
): SessionPick | null {
	return options.find((o) => o.label === selectedLabel)?.pick ?? null;
}

/** A compact, deterministic "MM-DD HH:mm" (UTC) stamp for a picker row. */
function formatSessionTime(date: Date): string {
	return date.toISOString().slice(5, 16).replace("T", " ");
}
