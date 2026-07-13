/**
 * The reply gate: who gets the first word on a message from an outside person.
 *
 * When an interlocutor writes, the message does NOT go to the model immediately.
 * A per-chat owner-reply window (`ownerReplyWindowMs`, default 5 min) is armed,
 * giving the Owner first crack. If the Owner answers manually inside the window,
 * the batch is theirs — cancel it, the bot stays out. If the window expires with
 * the Owner still silent, the chat becomes *ready* and its whole pending batch is
 * handed to the model (priority is per chat/user, not per message).
 *
 * An Owner message stands the bot down for THAT batch and nothing more. There is
 * no freeze: the interlocutor's next message arms a fresh window, and if the Owner
 * lets it lapse the bot answers. So the Owner can keep talking in a chat without
 * switching the bot off in it — the bot simply keeps watching for whatever nobody
 * answered. (The old `takeover` sub-mode froze the chat outright, so not even a
 * wake-word could pull the bot back in; sub-modes are gone.)
 *
 * Pure and deterministic: an injectable {@link Clock} drives a dedicated
 * {@link TimerRegistry}, so it is unit-tested with a fake clock and carries no
 * Pi/grammY dependency.
 */
import {
	type Clock,
	systemClock,
	TIMER,
	TimerRegistry,
} from "../../core/timers";

export interface ReplyGateOptions {
	/** How long the Owner has to answer before the bot may step in (plan 300000). */
	ownerReplyWindowMs: number;
	clock?: Clock;
}

export class ReplyGate {
	private readonly pending = new Set<string>();
	private readonly timers: TimerRegistry;
	private readonly clock: Clock;
	private readonly ownerReplyWindowMs: number;

	constructor(options: ReplyGateOptions) {
		this.clock = options.clock ?? systemClock;
		this.ownerReplyWindowMs = options.ownerReplyWindowMs;
		this.timers = new TimerRegistry(this.clock);
	}

	/**
	 * An interlocutor message arrived: add it to the chat's pending batch and
	 * (re)arm the owner-reply window. The bot never replies immediately.
	 */
	onInterlocutorMessage(chatId: string): void {
		this.pending.add(chatId);
		this.timers.arm(chatId, TIMER.ownerReply, this.ownerReplyWindowMs);
	}

	/**
	 * A message the Owner typed manually arrived (the caller has already ruled out
	 * the bot's own sends): they handled this batch, so cancel the window and drop
	 * the pending messages. Only this batch — the chat is not switched off, and the
	 * interlocutor's next message arms a new window as usual.
	 */
	onOwnerMessage(chatId: string): void {
		this.timers.cancel(chatId, TIMER.ownerReply);
		this.pending.delete(chatId);
	}

	/**
	 * Advance time: return the chats whose owner-reply window has expired with the
	 * Owner still silent and messages still pending — these are ready to be served
	 * to the model.
	 */
	onTick(): string[] {
		const ready: string[] = [];
		for (const entry of this.timers.collectDue()) {
			if (entry.name !== TIMER.ownerReply) continue;
			if (this.pending.has(entry.chatId)) ready.push(entry.chatId);
		}
		return ready;
	}

	/** The bot has served this chat's batch — drop it. */
	clearServed(chatId: string): void {
		this.pending.delete(chatId);
	}

	/** Whether a chat has messages waiting for the window to expire. */
	hasPending(chatId: string): boolean {
		return this.pending.has(chatId);
	}

	/** How many chats are held in the owner-reply window (not yet handed on). */
	pendingCount(): number {
		return this.pending.size;
	}

	/** Ms left on the owner-reply window, or null when none is armed. */
	windowRemaining(chatId: string): number | null {
		return this.timers.remaining(chatId, TIMER.ownerReply);
	}

	/** Forget a chat entirely (cleared/closed). */
	remove(chatId: string): void {
		this.pending.delete(chatId);
		this.timers.cancelChat(chatId);
	}
}
