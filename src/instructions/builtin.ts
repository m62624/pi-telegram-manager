/**
 * Load and assemble the manager's system-instruction text.
 *
 * The extension ships default instruction Markdown next to this file
 * (`manager-common.md`, `manager.md`, `manager-first-message.md`, `connect.md`).
 * They are read at runtime from disk (Pi runs the extension from source, so they
 * sit beside the compiled module).
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
	/** Persistent base block (common + stance + user override), header-less. */
	base: string;
	/** First-contact addendum, appended only when the active chat has no history. */
	firstMessage: string;
	/** Re-opening addendum, appended when a chat resumes after a long silence. */
	reopen: string;
}

/**
 * Assemble the manager instruction blocks. `overrideText` is the already-read
 * content of the user's `instructionFiles` (global + manager);
 * `firstMessageOverride`/`reopenOverride` are the already-read templates, if any.
 */
export async function loadManagerInstructions(input: {
	fs: TelegramFs;
	/** The bot's name in the chat (the labeler); people may address it by this. */
	labeler?: string;
	/** Configured wake-words; surfaced so the model knows how it may be addressed. */
	mentionWords?: string[];
	overrideText?: string;
	firstMessageOverride?: string;
	reopenOverride?: string;
}): Promise<ManagerInstructions> {
	const common = await readBuiltin(input.fs, "manager-common.md");
	const stance = await readBuiltin(input.fs, "manager.md");
	const disclosure = await readBuiltin(input.fs, "manager-disclosure.md");
	const firstDefault = await readBuiltin(input.fs, "manager-first-message.md");
	const reopenDefault = await readBuiltin(input.fs, "manager-reopen.md");

	const parts = [common, stance];
	const name = input.labeler?.trim().replace(/:\s*$/, "");
	const wake = (input.mentionWords ?? [])
		.map((w) => w.trim())
		.filter(Boolean)
		.map((w) => `"${w}"`)
		.join(", ");
	if (name || wake) {
		const nameLine = name
			? `You appear in this chat as **${name}**. Treat being addressed by "${name}" (or as an AI/LLM/bot/assistant) as a message to you.`
			: "";
		const wakeLine = wake
			? `You also answer to the wake-word(s) ${wake} — but only when they are a direct question or request to you, never when merely mentioned in passing.`
			: "";
		parts.push(
			`## Your name\n\n${[nameLine, wakeLine].filter(Boolean).join(" ")}`,
		);
	}
	if (input.overrideText?.trim()) parts.push(input.overrideText.trim());
	// LAST, and after the override on purpose. The bot answers strangers on a real
	// person's behalf, so the one thing it must never do is pass for that person —
	// and the instruction that says so has to survive whatever the operator adds
	// above it, the way the last word in a prompt tends to. Everything else here is
	// theirs to rewrite; this is not, and no setting reaches it.
	if (disclosure) parts.push(disclosure);

	return {
		base: parts.filter(Boolean).join("\n\n"),
		firstMessage: input.firstMessageOverride?.trim() || firstDefault,
		reopen: input.reopenOverride?.trim() || reopenDefault,
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
