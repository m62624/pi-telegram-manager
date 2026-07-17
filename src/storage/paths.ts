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
	/**
	 * Everything we know ABOUT a chat that is not the chat itself: the ids we sent, the
	 * memory-pass queue, how far it has been answered and consolidated. One subject, one
	 * file — see `chat-state.ts`.
	 */
	chatStatePath: string;
	/** The on-disk layout this directory is written in — see `migrations.ts`. */
	schemaVersionPath: string;
	/**
	 * What we have put in the owner's DM and where it is: the topic threads we opened
	 * and the mode message we pinned — see `dm-state.ts`.
	 */
	dmStatePath: string;
	/**
	 * A one-shot note the session picker leaves for the next extension instance to
	 * re-arm the bridge after a session switch (see `connect-intent.ts`).
	 */
	connectIntentPath: string;
	/**
	 * The high-water mark of Telegram `update_id`s already taken in, so a message
	 * whose handler killed the process (a `shutdown`) is not redelivered and re-run
	 * on the next start — see `update-cursor.ts`.
	 */
	updateCursorPath: string;
	/**
	 * Files an earlier layout wrote, and only the migration runner may read.
	 *
	 * They are named here rather than spelled out inside the migration because a path
	 * this project once used is a fact about this project, and the place facts about
	 * paths live is this file. Nothing else may touch them: to the running bot they do
	 * not exist.
	 */
	legacy: {
		/** → `chatStatePath` (`sent`). */
		sentRegistryPath: string;
		/** → `chatStatePath` (`consolidation`). */
		consolidationQueuePath: string;
		/** → `chatStatePath` (`handledThrough` / `consolidatedThrough`). */
		chatCursorsPath: string;
		/** → `dmStatePath` (`topics`), including its own pre-rename `chat`/`log` keys. */
		topicsPath: string;
		/** → `dmStatePath` (`modePin`), including its historic single-id form. */
		modePinPath: string;
		/** → `schemaVersionPath`: the contact-fact schema had a marker of its own. */
		memoryVersionPath: string;
		/** Where the owner's settings file is copied before its keys are rewritten. */
		settingsBackupPath: string;
	};
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
		chatStatePath: join(extensionDir, "chat-state.json"),
		schemaVersionPath: join(extensionDir, "schema-version.json"),
		dmStatePath: join(extensionDir, "dm-state.json"),
		connectIntentPath: join(extensionDir, "connect-intent.json"),
		updateCursorPath: join(extensionDir, "update-cursor.json"),
		legacy: {
			sentRegistryPath: join(extensionDir, "sent-registry.json"),
			consolidationQueuePath: join(extensionDir, "consolidation-queue.json"),
			chatCursorsPath: join(extensionDir, "chat-cursors.json"),
			topicsPath: join(extensionDir, "topics.json"),
			modePinPath: join(extensionDir, "mode-pin.json"),
			memoryVersionPath: join(extensionDir, "memory-version.json"),
			settingsBackupPath: join(extensionDir, "settings.backup.json"),
		},
		chatsDir,
		contactsDir,
		managerWorkspaceDir: join(extensionDir, "manager-workspace"),
		toolOutputDir,
		chatFile: (chatId) => join(chatsDir, `${sanitizeSegment(chatId)}.jsonl`),
		contactFile: (userId) =>
			join(contactsDir, `${sanitizeSegment(userId)}.json`),
	};
}
