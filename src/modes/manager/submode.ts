/**
 * The reply gate shared by both manager sub-modes.
 *
 * The rule the user wants is the same in `observer` and `takeover`: when an
 * interlocutor writes, the message does NOT go to the model immediately. A
 * per-chat owner-reply window (`ownerReplyWindowMs`, default 5 min) is armed,
 * giving the Owner first crack. If the Owner answers manually inside the window,
 * the batch is theirs — cancel it, the bot stays out. If the window expires with
 * the Owner still silent, the chat becomes *ready* and its whole pending batch
 * is handed to the model (priority is per chat/user, not per message).
 *
 * The only sub-mode difference lives here as a status flag: in `takeover` an
 * Owner message additionally *freezes* the chat (the Owner has taken over) until
 * they are away again; the window expiry clears it. `observer` never freezes.
 * The behavioural difference (co-pilot vs running the chat) is realized through
 * the injected instructions, not the timing.
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
import type { ManagerSubMode } from "../../storage/singleton-store";

export interface ReplyGateOptions {
	subMode: ManagerSubMode;
	/** How long the Owner has to answer before the bot may step in (plan 300000). */
	ownerReplyWindowMs: number;
	clock?: Clock;
}

export class ReplyGate {
	private readonly pending = new Set<string>();
	private readonly frozen = new Set<string>();
	private readonly timers: TimerRegistry;
	private readonly clock: Clock;
	private readonly subMode: ManagerSubMode;
	private readonly ownerReplyWindowMs: number;

	constructor(options: ReplyGateOptions) {
		this.clock = options.clock ?? systemClock;
		this.subMode = options.subMode;
		this.ownerReplyWindowMs = options.ownerReplyWindowMs;
		this.timers = new TimerRegistry(this.clock);
	}

	/**
	 * An interlocutor message arrived: add it to the chat's pending batch and
	 * (re)arm the owner-reply window. Applies in both sub-modes — the bot never
	 * replies immediately.
	 */
	onInterlocutorMessage(chatId: string): void {
		this.pending.add(chatId);
		this.timers.arm(chatId, TIMER.ownerReply, this.ownerReplyWindowMs);
	}

	/**
	 * A message the Owner typed manually arrived (the caller has already ruled out
	 * the bot's own sends): they handled the batch, so cancel the window and drop
	 * the pending messages. In `takeover` also freeze the chat until the Owner is
	 * away again.
	 */
	onOwnerMessage(chatId: string): void {
		this.timers.cancel(chatId, TIMER.ownerReply);
		this.pending.delete(chatId);
		if (this.subMode === "takeover") this.frozen.add(chatId);
	}

	/**
	 * Advance time: return the chats whose owner-reply window has expired with the
	 * Owner still silent and messages still pending — these are ready to be served
	 * to the model. Expiry also clears a takeover freeze (the Owner is away).
	 */
	onTick(): string[] {
		const ready: string[] = [];
		for (const entry of this.timers.collectDue()) {
			if (entry.name !== TIMER.ownerReply) continue;
			this.frozen.delete(entry.chatId);
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

	/** Ms left on the owner-reply window, or null when none is armed. */
	windowRemaining(chatId: string): number | null {
		return this.timers.remaining(chatId, TIMER.ownerReply);
	}

	/** Whether the chat is frozen by the Owner (takeover status only). */
	isFrozen(chatId: string): boolean {
		return this.frozen.has(chatId);
	}

	/** Forget a chat entirely (cleared/closed). */
	remove(chatId: string): void {
		this.pending.delete(chatId);
		this.frozen.delete(chatId);
		this.timers.cancelChat(chatId);
	}
}
