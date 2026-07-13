/**
 * Smart catch-up: when the manager is switched on, decide which chats it should
 * answer *for* the owner right away — without spamming every contact.
 *
 * A chat qualifies only when ALL hold:
 *  1. the interlocutor spoke last (nobody answered them);
 *  2. enough time has passed that the owner already had their window
 *     (`> ownerReplyWindowMs` since that last message);
 *  3. the chat is still recent (last message within `catchUpWindowMs`, default
 *     10 h) — stale threads are left alone;
 *  4. the last interlocutor message actually carries text — a bare reaction /
 *     empty sticker is not something to chase.
 *
 * Pure and deterministic (records are supplied by the caller, which handles the
 * disk enumeration), so it is fully unit-testable. Selected chats are returned
 * oldest-waiting first, so the manager works through the backlog fairly.
 */
import type { ChatMessageRecord } from "../../storage/chat-store";
import { analyzeChat } from "./conversation-state";

export interface CatchUpChat {
	chatId: string;
	records: readonly ChatMessageRecord[];
}

export interface CatchUpOptions {
	/** The owner's reply window; a chat is only chased after it has elapsed. */
	ownerReplyWindowMs: number;
	/** How far back a chat may be and still be chased (default 10 h). */
	catchUpWindowMs: number;
}

/** The display name of the most recent interlocutor message, if any. */
export function lastInterlocutorName(
	records: readonly ChatMessageRecord[],
): string | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		if (records[i].author === "interlocutor") return records[i].senderName;
	}
	return undefined;
}

/**
 * The interlocutor's user id from a stored transcript — never the owner's.
 *
 * `ownerId` is not a nicety: an early transcript can hold the OWNER's own messages
 * filed as `interlocutor` (they were written before the bot learned which Secretary
 * account it speaks for, and who authored a message is decided by that id). Reading one
 * of those back made the chat look like a self-chat — and consolidation DROPS a
 * self-chat, so a real contact was silently never remembered. Seen live: the queue held
 * the owner's own id for a friend's chat, and that friend accumulated no facts at all.
 */
export function lastInterlocutorUserId(
	records: readonly ChatMessageRecord[],
	ownerId?: string,
): string | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record.author !== "interlocutor" || !record.senderId) continue;
		if (record.senderId === ownerId) continue;
		return record.senderId;
	}
	return undefined;
}

/** Last interlocutor message text (already the newest, since it spoke last). */
function lastInterlocutorText(
	records: readonly ChatMessageRecord[],
): string | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		if (records[i].author === "interlocutor") return records[i].text;
	}
	return undefined;
}

/** Pick the chats to catch up on, oldest-waiting first. */
export function selectCatchUpChats(
	chats: readonly CatchUpChat[],
	now: number,
	options: CatchUpOptions,
): string[] {
	const selected: { chatId: string; waitingSince: number }[] = [];
	for (const chat of chats) {
		const state = analyzeChat(chat.records);
		if (!state.interlocutorWaiting) continue;
		if (state.lastInterlocutorAt === null || state.lastMessageAt === null)
			continue;
		if (now - state.lastInterlocutorAt <= options.ownerReplyWindowMs) continue;
		if (now - state.lastMessageAt > options.catchUpWindowMs) continue;
		if (!lastInterlocutorText(chat.records)?.trim()) continue;
		selected.push({
			chatId: chat.chatId,
			waitingSince: state.lastInterlocutorAt,
		});
	}
	return selected
		.sort((a, b) => a.waitingSince - b.waitingSince)
		.map((entry) => entry.chatId);
}
