/**
 * Finding plugmem's `config.toml`, and putting one there when there is none.
 *
 * The file belongs to the owner, not to this extension. plugmem already documents
 * every key it takes, validates them itself and reports what it did not understand;
 * mirroring a chosen few of them into `settings.json` bought nothing but two places
 * to state the same thing and a code change here for every key the engine gains. So
 * `settings.json` says only WHERE the file is, and everything about the engine is
 * said in the file.
 *
 * Two rules, and they are deliberately asymmetric:
 *
 *  - a missing file at the DEFAULT location is how somebody asks for the defaults
 *    back, so it is written again without a word;
 *  - a missing file at a location the owner NAMED is almost always a typo, and the
 *    kind that is discovered by editing a file nothing reads. One is written there
 *    — where they pointed, so the next edit lands in the right place — and said out
 *    loud.
 *
 * Pure of its own I/O decisions otherwise: it never edits a file that exists.
 */

import { dirname, isAbsolute, join, normalize } from "node:path";
import type { TelegramFs } from "./fs";
import {
	buildPlugmemConfig,
	DEFAULT_PLUGMEM_CONFIG,
	type EmbedderSettings,
	validateEmbedder,
} from "./plugmem-config";

export interface EnsureConfigInput {
	fs: TelegramFs;
	/** Where the file lives when the setting is unset. */
	defaultPath: string;
	/** The extension's own directory; a relative setting is read from here. */
	extensionDir: string;
	/** `memory.plugmemConfig`. */
	configured?: string;
	/** Expands a leading `~`; injected so the rule is testable. */
	home?: string;
	/**
	 * The pre-0.8 `memory.embedder` settings, when the owner still has them.
	 *
	 * Used to write the file the first time, so an upgrade keeps the embedder that
	 * was already working instead of silently switching it off.
	 */
	legacy?: EmbedderSettings;
}

export interface EnsuredConfig {
	path: string;
	/** True when this call wrote it, which is what a caller reports. */
	created: boolean;
	/** One line for the owner; empty when there is nothing to say. */
	notice: string;
}

/**
 * Resolve the configured path.
 *
 * Relative to the extension's own directory rather than the working directory: Pi
 * starts wherever the owner happens to be, and a config file that moves with the
 * shell is a config file nobody can find twice.
 */
export function resolveConfigPath(
	input: Pick<
		EnsureConfigInput,
		"defaultPath" | "extensionDir" | "configured" | "home"
	>,
): string {
	const raw = input.configured?.trim() ?? "";
	if (raw === "") return input.defaultPath;
	const expanded =
		input.home !== undefined && (raw === "~" || raw.startsWith("~/"))
			? join(input.home, raw.slice(1))
			: raw;
	return normalize(
		isAbsolute(expanded) ? expanded : join(input.extensionDir, expanded),
	);
}

/** The file plugmem will be opened with, guaranteed to exist. */
export async function ensurePlugmemConfig(
	input: EnsureConfigInput,
): Promise<EnsuredConfig> {
	const { fs } = input;
	const path = resolveConfigPath(input);
	const named = (input.configured?.trim() ?? "") !== "";

	if (await fs.exists(path)) {
		return {
			path,
			created: false,
			// The file wins, and it has to: it is the one plugmem reads. Saying so is
			// what stops the owner tuning settings that are no longer consulted.
			notice:
				input.legacy === undefined
					? ""
					: `Memory: your settings still have "memory.embedder", but the embedder is configured in ${path} now, and that file is what plugmem reads. You can delete the section.`,
		};
	}

	const legacy = input.legacy;
	// Checked before it is written, not after: these values came out of a file the
	// owner typed, so the complaint names their key rather than arriving later as an
	// opinion about TOML.
	if (legacy !== undefined) validateEmbedder(legacy);
	await fs.mkdirp(dirname(path));
	await fs.writeTextAtomic(
		path,
		legacy === undefined ? DEFAULT_PLUGMEM_CONFIG : buildPlugmemConfig(legacy),
	);
	return {
		path,
		created: true,
		notice:
			legacy !== undefined
				? `Memory: your "memory.embedder" settings moved to ${path}, which is where plugmem is configured now. You can delete the section from settings.json; edit that file for anything else the engine takes.`
				: named
					? `Memory: there was no config file at ${path}, so a default one was written there. Edit it to configure plugmem.`
					: "",
	};
}
