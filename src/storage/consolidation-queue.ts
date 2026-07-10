/**
 * Persisted queue of chats awaiting an idle memory-consolidation pass.
 *
 * When a chat has activity the manager `upsert`s an entry stamped with the last
 * activity time (deduped by chat). The manager only runs consolidation on an
 * entry once it has been quiet long enough (`eligible`), and `remove`s it after.
 * Persisting the queue on disk means a backlog of pending consolidations
 * survives a restart instead of being silently forgotten.
 *
 * All mutations are read-modify-write under an in-process file lock, mirroring
 * `business-store`.
 */
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

export interface ConsolidationEntry {
	chatId: string;
	/** The interlocutor's Telegram user id (where facts are stored). */
	userId?: string;
	/** Last activity time (ms) — the quiet period is measured from here. */
	activityAt: number;
}

export interface ConsolidationQueue {
	/** Record/refresh a chat as a consolidation candidate (dedup by chatId). */
	upsert(entry: ConsolidationEntry): Promise<void>;
	/** Drop a chat (consolidated, cleared, or no longer relevant). */
	remove(chatId: string): Promise<void>;
	/** Every queued entry. */
	all(): Promise<ConsolidationEntry[]>;
	/**
	 * The oldest-activity entry that has been quiet for at least `quietMs`, or null
	 * when none is due yet.
	 */
	eligible(now: number, quietMs: number): Promise<ConsolidationEntry | null>;
}

type QueueFile = { entries: ConsolidationEntry[] };

export function createConsolidationQueue(
	fs: TelegramFs,
	path: string,
): ConsolidationQueue {
	async function read(): Promise<ConsolidationEntry[]> {
		return (await readJsonIfExists<QueueFile>(fs, path))?.entries ?? [];
	}

	return {
		async upsert(entry) {
			await withFileWriteLock(path, async () => {
				const entries = await read();
				const next = entries.filter((e) => e.chatId !== entry.chatId);
				next.push(entry);
				await writeJson<QueueFile>(fs, path, { entries: next });
			});
		},
		async remove(chatId) {
			await withFileWriteLock(path, async () => {
				const entries = await read();
				await writeJson<QueueFile>(fs, path, {
					entries: entries.filter((e) => e.chatId !== chatId),
				});
			});
		},
		all: read,
		async eligible(now, quietMs) {
			const due = (await read())
				.filter((e) => now - e.activityAt >= quietMs)
				.sort((a, b) => a.activityAt - b.activityAt);
			return due[0] ?? null;
		},
	};
}
