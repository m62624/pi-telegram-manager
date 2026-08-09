import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/**
 * A one-shot note left on disk by the session picker for the NEXT extension instance to
 * find.
 *
 * A session switch (`ctx.switchSession` / `ctx.newSession`) tears the whole extension
 * instance down and re-loads it in the same process: the old `pi` is poisoned and the
 * running bridge dies (verified live — see the Part 3 spike). The freshly-loaded
 * instance gets a `session_start` with a working base context, so THAT is where the
 * bridge is re-armed. This record is how the picker (which ran in the now-dead instance)
 * tells the new one "start this mode here". It is single-use: read once on the next
 * matching `session_start`, then cleared.
 *
 * Only `connect` (personal) and `mixed` bridge a session and rotate the personal topic,
 * so only they are re-armed; the pure manager mode never resumes a picked session.
 */
export type ReArmMode = "connect" | "mixed";

export interface ConnectIntent {
	mode: ReArmMode;
	/** The cwd the picker armed this for; the re-arm only fires for a session in it. */
	cwd: string;
	/**
	 * The session that was active when the picker armed the switch. A normal Pi launch
	 * has no previous session file, so this makes the note a hand-off marker rather than
	 * a persisted "start Telegram next time" flag.
	 */
	sourceSessionFile: string;
	/** The exact selected session file; absent only for the picker's "New" option. */
	targetSessionFile?: string;
	/** When it was armed (epoch ms), so a stale note left by a crash is ignored. */
	armedAt: number;
}

/** How the re-arm reads a `session_start`, kept apart from the fs so it is unit-testable. */
export interface IntentContext {
	cwd: string;
	/** `SessionStartEvent.reason` — only a replacement may re-arm the bridge. */
	reason: string;
	/** The file Pi was replacing; absent on ordinary startup/reload. */
	previousSessionFile?: string;
	/** The newly active file, used to bind a resume to the selected target. */
	sessionFile?: string;
	now: number;
	maxAgeMs: number;
}

/**
 * Whether a persisted intent should re-arm the bridge for THIS `session_start`.
 *
 * It must be for this project (`cwd`), it must come from a session replacement that has a
 * previous session file, and that file must be the one the picker was running in. This
 * is deliberately stricter than checking `reason`: a leftover note must never turn a
 * plain Pi launch into a Telegram launch.
 */
export function intentApplies(
	intent: ConnectIntent | null,
	ctx: IntentContext,
): boolean {
	if (!intent) return false;
	if (intent.cwd !== ctx.cwd) return false;
	if (ctx.reason !== "new" && ctx.reason !== "resume") return false;
	if (
		ctx.previousSessionFile === undefined ||
		ctx.previousSessionFile !== intent.sourceSessionFile
	)
		return false;
	if (
		intent.targetSessionFile !== undefined &&
		ctx.sessionFile !== intent.targetSessionFile
	)
		return false;
	return ctx.now - intent.armedAt <= ctx.maxAgeMs;
}

export interface ConnectIntentStore {
	/** Leave the note for the next instance (overwrites any previous one). */
	arm(intent: ConnectIntent): Promise<void>;
	/** Read the note without consuming it. */
	load(): Promise<ConnectIntent | null>;
	/** Remove the note — always after it is read, whether or not it applied. */
	clear(): Promise<void>;
}

export function createConnectIntentStore(
	fs: TelegramFs,
	path: string,
): ConnectIntentStore {
	return {
		async arm(intent) {
			await withFileWriteLock(path, () => writeJson(fs, path, intent));
		},
		async load() {
			return await readJsonIfExists<ConnectIntent>(fs, path);
		},
		async clear() {
			await withFileWriteLock(path, () => fs.removeFile(path).catch(() => {}));
		},
	};
}
