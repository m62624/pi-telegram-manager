import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeMode } from "../constants";
import type { TelegramSettings } from "../settings/schema";
import type { TelegramFs } from "../storage/fs";

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * The instruction files that apply for a mode: the global set plus the
 * mode-specific set. Empty when a mode is not active (the caller only calls
 * this while a mode is explicitly active, so instructions never inject
 * otherwise).
 */
export function collectInstructionFiles(
	settings: TelegramSettings,
	mode: BridgeMode,
): string[] {
	const modeFiles =
		mode === "connect"
			? settings.connect.instructionFiles
			: settings.manager.instructionFiles;
	return [...settings.instructionFiles, ...modeFiles];
}

export interface ReadInstructionsResult {
	/** Concatenated instruction text (blank when nothing readable). */
	text: string;
	/** Files that were configured but could not be read. */
	missing: string[];
}

/**
 * Read and concatenate instruction files (expanding `~`). A missing/unreadable
 * file is reported in `missing` and skipped — a bad path never breaks a turn.
 */
export async function readInstructionFiles(
	fs: TelegramFs,
	files: string[],
): Promise<ReadInstructionsResult> {
	const parts: string[] = [];
	const missing: string[] = [];
	for (const file of files) {
		const resolved = expandHome(file);
		try {
			const content = (await fs.readText(resolved)).trim();
			if (content) parts.push(content);
		} catch {
			missing.push(file);
		}
	}
	return { text: parts.join("\n\n"), missing };
}
