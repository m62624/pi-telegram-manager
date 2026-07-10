/**
 * Create the Pi session file that mode 2 (the business manager) opens in its
 * own working directory.
 *
 * The manager command opens a fresh session in a dedicated folder by writing a
 * Pi session-header file, then calling `ctx.switchSession(file)` (only
 * available on `ExtensionCommandContext`, so the call itself lives in the
 * command handler — not here). This module just writes the header file, so it
 * needs no SDK import and is testable with the in-memory fs fake.
 *
 * The file layout mirrors Pi's own convention (see pi-planner's session
 * handoff): `<agentDir>/sessions/--<sanitized-cwd>--/<timestamp>_<uuid>.jsonl`,
 * whose first line is the JSON session header.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TelegramFs } from "../storage/fs";

/**
 * Pi's own session-file header. `version` is Pi's format version (3), not this
 * extension's — bumping it only makes sense if Pi changes its header contract.
 */
export interface PiSessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface CreatedPiSession {
	sessionDir: string;
	sessionFile: string;
	header: PiSessionHeader;
}

/** The Pi sessions directory for a given working directory (`--<sanitized-cwd>--`). */
export function piSessionDir(agentDir: string, cwd: string): string {
	const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/** Write a fresh Pi session-header file for `cwd`; returns the path to hand to switchSession. */
export async function createPiSession(input: {
	fs: TelegramFs;
	agentDir: string;
	cwd: string;
	parentSession?: string | null;
	now?: Date;
	sessionId?: string;
}): Promise<CreatedPiSession> {
	const timestamp = (input.now ?? new Date()).toISOString();
	const sessionId = input.sessionId ?? randomUUID();
	const sessionDir = piSessionDir(input.agentDir, input.cwd);
	const sessionFile = join(
		sessionDir,
		`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
	);
	const header: PiSessionHeader = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp,
		cwd: input.cwd,
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};
	await input.fs.mkdirp(sessionDir);
	await input.fs.writeTextAtomic(sessionFile, `${JSON.stringify(header)}\n`);
	return { sessionDir, sessionFile, header };
}
