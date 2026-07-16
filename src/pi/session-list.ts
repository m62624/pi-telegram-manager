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
