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

	/** The bot finished replying to the active chat — arm its continuation window. */
	onReplied(): void {
		if (this.active !== null) {
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
		this.active = this.waiting.shift() ?? null;
		return { released, promoted: this.active };
	}

	/**
	 * Drop a chat entirely (cleared/closed). If it was active, the next queued
	 * chat is promoted and returned.
	 */
	remove(chatId: string): { promoted: string | null } {
		this.timers.cancelChat(chatId);
		const index = this.waiting.indexOf(chatId);
		if (index !== -1) this.waiting.splice(index, 1);
		if (this.active === chatId) {
			this.active = this.waiting.shift() ?? null;
			return { promoted: this.active };
		}
		return { promoted: null };
	}
}
