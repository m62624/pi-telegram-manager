/**
 * The "smartness" core: read a chat transcript and separate the owner's thread
 * from the interlocutor's, so the manager can reason about *state* rather than
 * just the last line.
 *
 * Pure over {@link ChatMessageRecord}[] (oldest-first, as the chat store returns
 * them). Used by:
 *  - catch-up ({@link ./catchup}) — decide whether a chat is waiting for a reply
 *    the owner never gave;
 *  - the controller — summarise the state into the model's context, and never
 *    trigger a turn when the last speaker was the owner.
 */
import type { ChatAuthor, ChatMessageRecord } from "../../storage/chat-store";

export interface ConversationState {
	/** Timestamp of the owner's most recent message, or null if none. */
	lastOwnerAt: number | null;
	/** Timestamp of the interlocutor's most recent message, or null if none. */
	lastInterlocutorAt: number | null;
	/** Timestamp of the bot's most recent message, or null if none. */
	lastBotAt: number | null;
	/** Timestamp of the most recent message from anyone, or null when empty. */
	lastMessageAt: number | null;
	/** Who spoke last, or null when the transcript is empty. */
	lastAuthor: ChatAuthor | null;
	/** How many times the bot has replied in this chat (never-replied = 0). */
	botReplies: number;
	/**
	 * The owner or the bot has spoken at or after the interlocutor's last message
	 * (true when there is no interlocutor message at all).
	 */
	answered: boolean;
	/** The interlocutor spoke last — nobody (owner or bot) has responded yet. */
	interlocutorWaiting: boolean;
}

/** Separate the owner/interlocutor/bot threads and summarise the chat's state. */
export function analyzeChat(
	records: readonly ChatMessageRecord[],
): ConversationState {
	let lastOwnerAt: number | null = null;
	let lastInterlocutorAt: number | null = null;
	let lastBotAt: number | null = null;
	let botReplies = 0;
	for (const record of records) {
		if (record.author === "owner") lastOwnerAt = record.timestamp;
		else if (record.author === "interlocutor")
			lastInterlocutorAt = record.timestamp;
		else if (record.author === "bot") {
			lastBotAt = record.timestamp;
			botReplies += 1;
		}
	}
	const last = records.at(-1) ?? null;
	const lastAuthor = last?.author ?? null;
	const responderAt = Math.max(lastOwnerAt ?? -1, lastBotAt ?? -1);
	const answered =
		lastInterlocutorAt === null ? true : responderAt >= lastInterlocutorAt;
	return {
		lastOwnerAt,
		lastInterlocutorAt,
		lastBotAt,
		lastMessageAt: last?.timestamp ?? null,
		lastAuthor,
		botReplies,
		answered,
		interlocutorWaiting: lastAuthor === "interlocutor",
	};
}
