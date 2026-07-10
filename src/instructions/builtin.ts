/**
 * Load and assemble the manager's system-instruction text.
 *
 * The extension ships default instruction Markdown next to this file
 * (`manager-common.md`, `manager-observer.md`, `manager-takeover.md`,
 * `manager-first-message.md`, `connect.md`). They are read at runtime from disk
 * (Pi runs the extension from source, so they sit beside the compiled module).
 * A user's `settings.json` `instructionFiles` are layered on top as an override,
 * never replacing the built-in behaviour rules.
 *
 * The assembled block is delivered to the model as the first message of the
 * rebuilt manager context (see `pi.on("context")`), prefixed with
 * {@link SYSTEM_INSTRUCTIONS_HEADER}. Because that context is rebuilt before
 * every LLM call, the block is always present — including immediately after a
 * compaction — with no separate re-injection path.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelegramFs } from "../storage/fs";
import type { ManagerSubMode } from "../storage/singleton-store";

/** Header that marks the injected instruction block for the model. */
export const SYSTEM_INSTRUCTIONS_HEADER = "[SYSTEM_INSTRUCTIONS]";

const INSTRUCTIONS_DIR = dirname(fileURLToPath(import.meta.url));

/** Read a bundled instruction file; a missing/unreadable file yields "". */
async function readBuiltin(fs: TelegramFs, name: string): Promise<string> {
	try {
		return (await fs.readText(join(INSTRUCTIONS_DIR, name))).trim();
	} catch {
		return "";
	}
}

export interface ManagerInstructions {
	/** Persistent base block (common + sub-mode + user override), header-less. */
	base: string;
	/** First-contact addendum, appended only when the active chat has no history. */
	firstMessage: string;
}

/**
 * Assemble the manager instruction blocks for a sub-mode. `overrideText` is the
 * already-read content of the user's `instructionFiles` (global + manager);
 * `firstMessageOverride` is the already-read `firstMessageTemplate`, if any.
 */
export async function loadManagerInstructions(input: {
	fs: TelegramFs;
	subMode: ManagerSubMode;
	overrideText?: string;
	firstMessageOverride?: string;
}): Promise<ManagerInstructions> {
	const common = await readBuiltin(input.fs, "manager-common.md");
	const submode = await readBuiltin(
		input.fs,
		input.subMode === "takeover"
			? "manager-takeover.md"
			: "manager-observer.md",
	);
	const firstDefault = await readBuiltin(input.fs, "manager-first-message.md");

	const parts = [common, submode];
	if (input.overrideText?.trim()) parts.push(input.overrideText.trim());

	return {
		base: parts.filter(Boolean).join("\n\n"),
		firstMessage: input.firstMessageOverride?.trim() || firstDefault,
	};
}

/** Read the built-in mode-1 (connect) instructions plus any user override. */
export async function loadConnectInstructions(input: {
	fs: TelegramFs;
	overrideText?: string;
}): Promise<string> {
	const base = await readBuiltin(input.fs, "connect.md");
	const parts = [base];
	if (input.overrideText?.trim()) parts.push(input.overrideText.trim());
	return parts.filter(Boolean).join("\n\n");
}
