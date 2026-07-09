import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/**
 * Records the `message_id`s the bot itself sent, per chat. In business mode the
 * bot's own outgoing messages come back as updates "from the owner" and are
 * otherwise indistinguishable from the owner typing manually. The identity
 * layer consults this (plus a hidden marker) to tell bot-sent from owner-manual
 * so a manual owner message can freeze the chat (takeover) while the bot's own
 * replies do not. Bounded per chat to avoid unbounded growth across a restart.
 */
export interface SentRegistry {
	recordSent(chatId: string, messageId: number): Promise<void>;
	wasSentByBot(chatId: string, messageId: number): Promise<boolean>;
}

type RegistryMap = Record<string, number[]>;

const DEFAULT_MAX_PER_CHAT = 200;

export function createSentRegistry(
	fs: TelegramFs,
	path: string,
	options: { maxPerChat?: number } = {},
): SentRegistry {
	const maxPerChat = options.maxPerChat ?? DEFAULT_MAX_PER_CHAT;

	async function readMap(): Promise<RegistryMap> {
		return (await readJsonIfExists<RegistryMap>(fs, path)) ?? {};
	}

	return {
		async recordSent(chatId, messageId) {
			await withFileWriteLock(path, async () => {
				const map = await readMap();
				const ids = map[chatId] ?? [];
				if (!ids.includes(messageId)) {
					ids.push(messageId);
				}
				// Keep only the most recent ids.
				map[chatId] = ids.slice(-maxPerChat);
				await writeJson(fs, path, map);
			});
		},
		async wasSentByBot(chatId, messageId) {
			const map = await readMap();
			return (map[chatId] ?? []).includes(messageId);
		},
	};
}
