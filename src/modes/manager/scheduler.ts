/**
 * Deterministic chat scheduler for the manager (mode 2) — the Phase-3 bridge to
 * the manager runtime.
 *
 * One agent instance serves many chats, but only ONE chat is active at a time
 * (turns are serialized so tool_use/tool_result integrity is preserved). This
 * pure reducer decides *which* chat is active and *when* to move on:
 *
 *  - Chats are served FIFO by the arrival of their first message.
 *  - After the bot replies to the active chat, a continuation window
 *    (`continueWindowMs`, ~1:30) is armed. If the interlocutor writes again
 *    within it, their chat stays active and the window re-arms; if the window
 *    expires, the active slot is released and the next queued chat is promoted.
 *
 * It owns a dedicated {@link TimerRegistry} (continuation windows only) driven by
 * an injectable {@link Clock}, so the whole thing is unit-testable with a fake
 * clock and carries no Pi/grammY dependency. The manager runtime (Phase 4) wires
 * a wall-clock tick to {@link ChatScheduler.onTick} and feeds the active chat's
 * turn to the agent, calling {@link ChatScheduler.onReplied} when a reply lands.
 */
import {
	type Clock,
	systemClock,
	TIMER,
	TimerRegistry,
} from "../../core/timers";

/** What happened to an inbound interlocutor message, from the scheduler's view. */
export type MessageOutcome =
	| "active" // this chat is now the active one — process it
	| "queued" // another chat is active — this one waits its turn
	| "continued"; // this chat was already active — it's a continuation

/** The effect of advancing the clock. */
export interface TickResult {
	/** A chat whose continuation window expired and was released, if any. */
	released: string | null;
	/** A chat promoted to active from the queue, if any. */
	promoted: string | null;
}

export interface ChatSchedulerOptions {
	/** Continuation/priority window in ms (plan default 90000 = 1:30). */
	continueWindowMs: number;
	clock?: Clock;
}

export class ChatScheduler {
	private active: string | null = null;
	/** Chats waiting their turn, FIFO by first message. */
	private readonly waiting: string[] = [];
	/** Bot-reply count per chat; drives never-replied-first promotion. */
	private readonly replies = new Map<string, number>();
	private readonly timers: TimerRegistry;
	private readonly clock: Clock;
	private readonly continueWindowMs: number;

	constructor(options: ChatSchedulerOptions) {
		this.clock = options.clock ?? systemClock;
		this.continueWindowMs = options.continueWindowMs;
		this.timers = new TimerRegistry(this.clock);
	}

	/** The chat currently being served, or null when idle. */
	activeChat(): string | null {
		return this.active;
	}

	/** Chats waiting their turn, in service order. */
	pending(): string[] {
		return [...this.waiting];
	}

	/** Total chats tracked (active + waiting). */
	get size(): number {
		return this.waiting.length + (this.active === null ? 0 : 1);
	}

	/** Ms left on the active chat's continuation window, or null when none is armed. */
	continuationRemaining(): number | null {
		return this.active === null
			? null
			: this.timers.remaining(this.active, TIMER.continueWindow);
	}

	/** How many times the bot has replied in a chat (0 = never replied). */
	repliesFor(chatId: string): number {
		return this.replies.get(chatId) ?? 0;
	}

	/**
	 * Promote the highest-priority waiting chat to active and return it: the fewest
	 * bot replies wins (never-replied chats first), FIFO within a tier. No one
	 * starves while the bot keeps chatting with an already-answered contact.
	 */
	private promoteNext(): string | null {
		if (this.waiting.length === 0) {
			this.active = null;
			return null;
		}
		let bestIndex = 0;
		let bestReplies = this.repliesFor(this.waiting[0]);
		for (let i = 1; i < this.waiting.length; i += 1) {
			const count = this.repliesFor(this.waiting[i]);
			if (count < bestReplies) {
				bestReplies = count;
				bestIndex = i;
			}
		}
		const [chatId] = this.waiting.splice(bestIndex, 1);
		this.active = chatId;
		return chatId;
	}

	/**
	 * Register an interlocutor message for `chatId`. If nothing is active this
	 * chat becomes active; if it *is* the active chat this is a continuation (the
	 * pending window is cancelled — they answered); otherwise it queues (once,
	 * keeping its FIFO position).
	 */
	onMessage(chatId: string): MessageOutcome {
		if (this.active === chatId) {
			this.timers.cancel(chatId, TIMER.continueWindow);
			return "continued";
		}
		if (this.active === null) {
			// Invariant: active === null implies the queue is empty.
			this.active = chatId;
			return "active";
		}
		if (!this.waiting.includes(chatId)) this.waiting.push(chatId);
		return "queued";
	}

	/**
	 * The bot finished replying to the active chat — count the reply (so the chat
	 * drops in priority behind never-replied ones) and arm its continuation window.
	 */
	onReplied(): void {
		if (this.active !== null) {
			this.replies.set(this.active, this.repliesFor(this.active) + 1);
			this.timers.arm(this.active, TIMER.continueWindow, this.continueWindowMs);
		}
	}

	/**
	 * Advance time: if the active chat's continuation window has expired, release
	 * it and promote the next queued chat. Idempotent when nothing is due.
	 */
	onTick(): TickResult {
		const due = this.timers.collectDue();
		const expired = due.some(
			(entry) =>
				entry.name === TIMER.continueWindow && entry.chatId === this.active,
		);
		if (!expired || this.active === null) {
			return { released: null, promoted: null };
		}
		const released = this.active;
		this.timers.cancelChat(released);
		this.promoteNext();
		return { released, promoted: this.active };
	}

	/**
	 * The active chat has been served — release it and promote the next ready
	 * chat from the queue. Returns the newly active chat (or null when the queue
	 * is empty). Used when the reply gate, not a continuation window, drives
	 * turn-taking.
	 */
	next(): { promoted: string | null } {
		this.timers.cancelChat(this.active ?? "");
		this.promoteNext();
		return { promoted: this.active };
	}

	/**
	 * Drop a chat entirely (cleared/closed). If it was active, the next queued
	 * chat is promoted and returned.
	 */
	remove(chatId: string): { promoted: string | null } {
		this.timers.cancelChat(chatId);
		this.replies.delete(chatId);
		const index = this.waiting.indexOf(chatId);
		if (index !== -1) this.waiting.splice(index, 1);
		if (this.active === chatId) {
			this.promoteNext();
			return { promoted: this.active };
		}
		return { promoted: null };
	}
}
