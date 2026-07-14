/**
 * Everything the manager knows ABOUT a chat that is not the chat itself.
 *
 * The transcript lives in `chats/<id>.jsonl` and the person lives in
 * `contacts/<id>.json`. What was left over — the message ids we sent, whether the chat
 * is queued for a memory pass, how far it has been answered and consolidated — used to
 * live in three separate files, each with its own lock, its own read-modify-write, and
 * its own copy of the same key:
 *
 *     sent-registry.json        { "42": [1, 2, 3] }
 *     consolidation-queue.json  { entries: [{ chatId: "42", … }] }
 *     chat-cursors.json         { cursors: [{ chatId: "42", … }] }
 *
 * Three files, one subject. They were written on the same events, keyed by the same id,
 * and read by the same controller; nothing about them was ever independent. They are one
 * record now — and the three interfaces below are three VIEWS of it, so nothing upstream
 * had to learn that they had moved.
 *
 * One file means one lock, so a write to any view serialises against a write to any
 * other. That is a feature: they describe one chat, and a half-applied pair of updates
 * to the same chat was never something we wanted to be possible.
 */
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/** How many of the bot's own message ids are kept per chat. */
export const DEFAULT_MAX_SENT_PER_CHAT = 200;

/** A chat queued for an idle memory-consolidation pass. */
export interface ConsolidationEntry {
	chatId: string;
	/** The interlocutor's Telegram user id (where facts are stored). */
	userId?: string;
	/** Last activity time (ms) — the quiet period is measured from here. */
	activityAt: number;
}

/** How far the manager has got with a chat. See {@link ChatCursorStore}. */
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

/** One chat's whole bookkeeping record, as it sits on disk. */
export interface ChatStateRecord {
	chatId: string;
	/** Message ids the bot itself sent here (bounded, newest kept). */
	sent?: number[];
	/** Set while the chat is waiting for an idle memory pass. */
	consolidation?: { userId?: string; activityAt: number };
	handledThrough?: number;
	consolidatedThrough?: number;
}

/**
 * Records the `message_id`s the bot itself sent, per chat. In business mode the bot's own
 * outgoing messages come back as updates "from the owner" and are otherwise
 * indistinguishable from the owner typing manually. The identity layer consults this
 * (plus a hidden marker) to tell bot-sent from owner-manual, so a manual owner message
 * stands the bot down for that batch while the bot's own replies do not.
 */
export interface SentRegistry {
	recordSent(chatId: string, messageId: number): Promise<void>;
	wasSentByBot(chatId: string, messageId: number): Promise<boolean>;
}

/**
 * Chats awaiting an idle memory-consolidation pass.
 *
 * When a chat has activity the manager `upsert`s an entry stamped with the last activity
 * time (deduped by chat). The manager only runs consolidation on an entry once it has
 * been quiet long enough (`eligible`), and `remove`s it after. Persisting the queue means
 * a backlog survives a restart instead of being silently forgotten.
 */
export interface ConsolidationQueue {
	upsert(entry: ConsolidationEntry): Promise<void>;
	remove(chatId: string): Promise<void>;
	all(): Promise<ConsolidationEntry[]>;
	/**
	 * The oldest-activity entry that has been quiet for at least `quietMs`, or null when
	 * none is due yet.
	 */
	eligible(now: number, quietMs: number): Promise<ConsolidationEntry | null>;
}

/**
 * How far each chat has been taken — the memory a restart used to wipe.
 *
 * The transcript records what was SAID. It has no idea what was DECIDED, and those are
 * not the same thing: a turn that ended in silence writes nothing, and a memory pass
 * writes facts without saying which messages they came from. Both decisions lived only in
 * the process that made them, so every restart re-derived them from the same transcript —
 * yesterday's finished conversation was answered again, and interrogated again.
 *
 * Both marks are monotonic: a cursor never moves backwards, because "already handled"
 * cannot become false.
 */
export interface ChatCursorStore {
	get(chatId: string): Promise<ChatCursor | null>;
	/** Every chat's marks, as a map — one read for a whole catch-up scan. */
	all(): Promise<Map<string, ChatCursor>>;
	/** This chat is answered through `at` (no-op if it already reaches further). */
	markHandled(chatId: string, at: number): Promise<void>;
	/** This chat's memory is consolidated through `at` (same monotonic rule). */
	markConsolidated(chatId: string, at: number): Promise<void>;
}

/** The three views, over one file. */
export interface ChatState {
	sentRegistry: SentRegistry;
	consolidationQueue: ConsolidationQueue;
	cursors: ChatCursorStore;
	/** Every record, for migrations and diagnostics. */
	all(): Promise<ChatStateRecord[]>;
	/**
	 * Forget a chat entirely — every view of it at once. For a chat whose transcript is
	 * gone; it is deliberately NOT on one of the views, because it is not one view's
	 * decision to make.
	 */
	forget(chatId: string): Promise<void>;
}

type StateFile = { chats: ChatStateRecord[] };

export function createChatState(
	fs: TelegramFs,
	path: string,
	options: { maxSentPerChat?: number } = {},
): ChatState {
	const maxSent = options.maxSentPerChat ?? DEFAULT_MAX_SENT_PER_CHAT;

	async function read(): Promise<ChatStateRecord[]> {
		return (await readJsonIfExists<StateFile>(fs, path))?.chats ?? [];
	}

	async function find(chatId: string): Promise<ChatStateRecord | null> {
		return (await read()).find((chat) => chat.chatId === chatId) ?? null;
	}

	/**
	 * Read, hand the caller the chat's record to change, write back — under the lock, and
	 * the WHOLE file, exactly as each of the three files did on its own.
	 *
	 * Two rules make it safe to have three writers on one file:
	 *
	 *  - a writer touches ONLY its own fields. `change` is handed the live record and every
	 *    caller below sets one thing on it; nothing here reads a field it does not own, and
	 *    nothing writes one. That is what stops a `recordSent` from carrying a stale copy of
	 *    a cursor back to disk — it never had a copy, it had the record.
	 *  - empty records do not survive the trip. A change can legitimately decide to do
	 *    nothing (a cursor that would move backwards), and without this the file would grow
	 *    a `{ chatId }` for every chat that was ever asked about and answered "no".
	 */
	async function edit(
		chatId: string,
		change: (record: ChatStateRecord) => void,
	): Promise<void> {
		await withFileWriteLock(path, async () => {
			const chats = await read();
			let record = chats.find((chat) => chat.chatId === chatId);
			if (!record) {
				record = { chatId };
				chats.push(record);
			}
			change(record);
			await writeJson<StateFile>(fs, path, {
				chats: chats.filter((chat) => !isEmpty(chat)),
			});
		});
	}

	/** A record nobody knows anything about any more is not worth a line in the file. */
	function isEmpty(record: ChatStateRecord): boolean {
		return (
			(record.sent?.length ?? 0) === 0 &&
			record.consolidation === undefined &&
			record.handledThrough === undefined &&
			record.consolidatedThrough === undefined
		);
	}

	/** The queue view of the file: the chats currently waiting for a memory pass. */
	async function queued(): Promise<ConsolidationEntry[]> {
		const entries: ConsolidationEntry[] = [];
		for (const record of await read()) {
			if (!record.consolidation) continue;
			entries.push({
				chatId: record.chatId,
				userId: record.consolidation.userId,
				activityAt: record.consolidation.activityAt,
			});
		}
		return entries;
	}

	async function advanceCursor(
		chatId: string,
		at: number,
		field: "handledThrough" | "consolidatedThrough",
	): Promise<void> {
		if (!Number.isFinite(at)) return;
		await edit(chatId, (record) => {
			const current = record[field];
			// Monotonic. A pass over an older window, or a turn that settled on a message we
			// had already dealt with, must never un-handle what is handled.
			if (current !== undefined && current >= at) return;
			record[field] = at;
		});
	}

	return {
		all: read,

		sentRegistry: {
			async recordSent(chatId, messageId) {
				await edit(chatId, (record) => {
					const ids = record.sent ?? [];
					if (!ids.includes(messageId)) ids.push(messageId);
					record.sent = ids.slice(-maxSent);
				});
			},
			async wasSentByBot(chatId, messageId) {
				return (await find(chatId))?.sent?.includes(messageId) ?? false;
			},
		},

		consolidationQueue: {
			async upsert(entry) {
				await edit(entry.chatId, (record) => {
					record.consolidation = {
						userId: entry.userId,
						activityAt: entry.activityAt,
					};
				});
			},
			async remove(chatId) {
				// Leaving the queue is not being forgotten. The cursors on this record are how
				// a restart knows the conversation has already been dealt with; taking them
				// out along with the queue entry would bring the whole
				// answer-everything-again-on-launch bug straight back.
				await edit(chatId, (record) => {
					record.consolidation = undefined;
				});
			},
			all: queued,
			async eligible(now, quietMs) {
				// Not `this.all()`: a view whose methods depend on how they were reached is a
				// view that breaks the first time someone destructures it.
				const due = (await queued())
					.filter((entry) => now - entry.activityAt >= quietMs)
					.sort((a, b) => a.activityAt - b.activityAt);
				return due[0] ?? null;
			},
		},

		cursors: {
			async get(chatId) {
				const record = await find(chatId);
				if (!record) return null;
				if (
					record.handledThrough === undefined &&
					record.consolidatedThrough === undefined
				) {
					return null;
				}
				return {
					chatId,
					handledThrough: record.handledThrough,
					consolidatedThrough: record.consolidatedThrough,
				};
			},
			async all() {
				const map = new Map<string, ChatCursor>();
				for (const record of await read()) {
					if (
						record.handledThrough === undefined &&
						record.consolidatedThrough === undefined
					) {
						continue;
					}
					map.set(record.chatId, {
						chatId: record.chatId,
						handledThrough: record.handledThrough,
						consolidatedThrough: record.consolidatedThrough,
					});
				}
				return map;
			},
			markHandled(chatId, at) {
				return advanceCursor(chatId, at, "handledThrough");
			},
			markConsolidated(chatId, at) {
				return advanceCursor(chatId, at, "consolidatedThrough");
			},
		},

		async forget(chatId) {
			await withFileWriteLock(path, async () => {
				const chats = await read();
				const next = chats.filter((chat) => chat.chatId !== chatId);
				if (next.length === chats.length) return;
				await writeJson<StateFile>(fs, path, { chats: next });
			});
		},
	};
}
