import { createTelegramPaths, type TelegramPaths } from "../storage/paths";
import { getAgentDir } from "./sdk";

/**
 * Resolve the extension's on-disk layout under the Pi agent directory
 * (`getAgentDir()/extensions/pi-telegram-manager/`). The SDK owns the agent-dir
 * resolution (env overrides, defaults); we only derive our subtree.
 */
export function resolveTelegramPaths(): TelegramPaths {
	return createTelegramPaths(getAgentDir());
}
