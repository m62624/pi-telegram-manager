import type { TelegramFs } from "../storage/fs";
import { readJsonIfExists } from "../storage/json";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type TelegramSettings,
} from "./schema";

export interface LoadedSettings {
	settings: TelegramSettings;
	warnings: string[];
}

/**
 * Load effective settings: defaults layered with the on-disk global file. Read
 * fresh on demand (not cached) so edits apply without a restart. A missing file
 * yields defaults; malformed JSON propagates as a `TelegramJsonError`.
 */
export async function loadSettings(
	fs: TelegramFs,
	settingsPath: string,
): Promise<LoadedSettings> {
	const raw = await readJsonIfExists<unknown>(fs, settingsPath);
	const warnings: string[] = [];
	const settings = normalizeSettings(raw ?? {}, warnings);
	return { settings, warnings };
}

export { DEFAULT_SETTINGS };
