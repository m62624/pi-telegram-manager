import { join } from "node:path";
import { EXTENSION_NAME } from "../constants";
import { sanitizeSegment } from "../path-utils";

/**
 * On-disk layout for the extension, all under
 * `<agentDir>/extensions/pi-telegram-manager/`.
 *
 * `agentDir` is passed in (resolved by `pi/agent-dir` via the SDK's
 * `getAgentDir()`) so this module stays pure and SDK-free — the `storage/`
 * domain never imports `@earendil-works/*`.
 */
export interface TelegramPaths {
	agentDir: string;
	extensionDir: string;
	/** Singleton binding of the active mode (mode 1/2), incl. pid/heartbeat. */
	singletonPath: string;
	settingsPath: string;
	/** Business connection ids + rights (sensitive). */
	businessPath: string;
	/** Registry of message ids/UUIDs the bot sent (bot-vs-owner identity). */
	sentRegistryPath: string;
	/** Per-chat JSONL transcripts directory (manager last-N memory). */
	chatsDir: string;
	/** Working directory a mode-2 manager session is opened in. */
	managerWorkspaceDir: string;
	/** JSONL transcript path for one chat. */
	chatFile(chatId: string): string;
}

export function createTelegramPaths(agentDir: string): TelegramPaths {
	const extensionDir = join(agentDir, "extensions", EXTENSION_NAME);
	const chatsDir = join(extensionDir, "chats");
	return {
		agentDir,
		extensionDir,
		singletonPath: join(extensionDir, "singleton.json"),
		settingsPath: join(extensionDir, "settings.json"),
		businessPath: join(extensionDir, "business.json"),
		sentRegistryPath: join(extensionDir, "sent-registry.json"),
		chatsDir,
		managerWorkspaceDir: join(extensionDir, "manager-workspace"),
		chatFile: (chatId) => join(chatsDir, `${sanitizeSegment(chatId)}.jsonl`),
	};
}
