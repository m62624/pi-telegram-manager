/**
 * How far the manager has already got with each chat — the memory a restart used to
 * wipe.
 *
 * The transcript records what was SAID. It has no idea what was DECIDED, and those
 * are not the same thing. Two decisions leave no trace in it at all:
 *
 *  - the bot read the newest messages and deliberately said nothing (banter, a
 *    sticker, a laugh) — no reply is appended, so the transcript still shows the
 *    interlocutor speaking last, forever;
 *  - the bot ran a memory pass over the chat — facts land in the contact's file,
 *    but nothing says WHICH messages they were drawn from.
 *
 * Both decisions lived only in the process that made them (`unserved`, the
 * consolidation queue), so every restart re-derived the same conclusions from the
 * same transcript: yesterday's finished conversation was answered again, and
 * interrogated again — once per launch, indefinitely.
 *
 * So each chat carries two marks, and they are the only durable answer to "is there
 * anything here we have not dealt with?". Both are monotonic: a cursor never moves
 * backwards, because "already handled" cannot become false.
 *
 * All mutations are read-modify-write under an in-process file lock, mirroring
 * `consolidation-queue`.
 */
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

export interface ChatCursor {
	chatId: string;
	/**
	 * The newest interlocutor message a turn has SETTLED on — replied to, judged not
	 * worth a reply, or dropped by the guard. Anything at or before it is dealt with,
	 * whatever the transcript looks like.
	 */
	handledThrough?: number;
	/** The newest message a memory pass has already read (its facts are extracted). */
	consolidatedThrough?: number;
}

export interface ChatCursorStore {
	get(chatId: string): Promise<ChatCursor | null>;
	/** Every chat's marks, as a map — one read for a whole catch-up scan. */
	all(): Promise<Map<string, ChatCursor>>;
	/** This chat is answered through `at` (no-op if it already reaches further). */
	markHandled(chatId: string, at: number): Promise<void>;
	/** This chat's memory is consolidated through `at` (same monotonic rule). */
	markConsolidated(chatId: string, at: number): Promise<void>;
	/** Forget a chat entirely (its transcript is gone). */
	remove(chatId: string): Promise<void>;
}

type CursorFile = { cursors: ChatCursor[] };

export function createChatCursorStore(
	fs: TelegramFs,
	path: string,
): ChatCursorStore {
	async function read(): Promise<ChatCursor[]> {
		return (await readJsonIfExists<CursorFile>(fs, path))?.cursors ?? [];
	}

	async function advance(
		chatId: string,
		at: number,
		field: "handledThrough" | "consolidatedThrough",
	): Promise<void> {
		if (!Number.isFinite(at)) return;
		await withFileWriteLock(path, async () => {
			const cursors = await read();
			const existing = cursors.find((cursor) => cursor.chatId === chatId);
			if (existing) {
				const current = existing[field];
				// Monotonic. A pass over an older window, or a turn that settled on a
				// message we had already dealt with, must never un-handle what is handled.
				if (current !== undefined && current >= at) return;
				existing[field] = at;
			} else {
				cursors.push({ chatId, [field]: at });
			}
			await writeJson<CursorFile>(fs, path, { cursors });
		});
	}

	return {
		async get(chatId) {
			return (await read()).find((cursor) => cursor.chatId === chatId) ?? null;
		},

		async all() {
			const map = new Map<string, ChatCursor>();
			for (const cursor of await read()) map.set(cursor.chatId, cursor);
			return map;
		},

		markHandled(chatId, at) {
			return advance(chatId, at, "handledThrough");
		},

		markConsolidated(chatId, at) {
			return advance(chatId, at, "consolidatedThrough");
		},

		async remove(chatId) {
			await withFileWriteLock(path, async () => {
				const cursors = await read();
				const next = cursors.filter((cursor) => cursor.chatId !== chatId);
				if (next.length === cursors.length) return;
				await writeJson<CursorFile>(fs, path, { cursors: next });
			});
		},
	};
}
