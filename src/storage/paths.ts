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
	/** Persisted queue of chats awaiting idle memory consolidation. */
	consolidationQueuePath: string;
	/** Marker of the applied contact-fact schema version (one-off migrations). */
	memoryVersionPath: string;
	/** Thread ids of the personal/manager topics in the owner's bot DM. */
	topicsPath: string;
	/** The pinned "current mode" message in the owner's DM (survives restarts). */
	modePinPath: string;
	/** Per-chat JSONL transcripts directory (manager last-N memory). */
	chatsDir: string;
	/** Per-contact profile + important-facts directory (both modes). */
	contactsDir: string;
	/** Working directory a mode-2 manager session is opened in. */
	managerWorkspaceDir: string;
	/**
	 * Scratch directory for full tool outputs we save ourselves before attaching them
	 * (see `core/tool-output-file`). Inside the extension dir — never the system temp
	 * dir — so the path is ours on every platform and the file is deleted right after
	 * it is sent.
	 */
	toolOutputDir: string;
	/** JSONL transcript path for one chat. */
	chatFile(chatId: string): string;
	/** JSON profile + facts path for one contact (keyed by Telegram user id). */
	contactFile(userId: string): string;
}

export function createTelegramPaths(agentDir: string): TelegramPaths {
	const extensionDir = join(agentDir, "extensions", EXTENSION_NAME);
	const chatsDir = join(extensionDir, "chats");
	const contactsDir = join(extensionDir, "contacts");
	const toolOutputDir = join(extensionDir, "tool-output");
	return {
		agentDir,
		extensionDir,
		singletonPath: join(extensionDir, "singleton.json"),
		settingsPath: join(extensionDir, "settings.json"),
		businessPath: join(extensionDir, "business.json"),
		sentRegistryPath: join(extensionDir, "sent-registry.json"),
		consolidationQueuePath: join(extensionDir, "consolidation-queue.json"),
		memoryVersionPath: join(extensionDir, "memory-version.json"),
		topicsPath: join(extensionDir, "topics.json"),
		modePinPath: join(extensionDir, "mode-pin.json"),
		chatsDir,
		contactsDir,
		managerWorkspaceDir: join(extensionDir, "manager-workspace"),
		toolOutputDir,
		chatFile: (chatId) => join(chatsDir, `${sanitizeSegment(chatId)}.jsonl`),
		contactFile: (userId) =>
			join(contactsDir, `${sanitizeSegment(userId)}.json`),
	};
}
