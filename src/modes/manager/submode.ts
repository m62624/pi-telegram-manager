/**
 * The `takeover` sub-mode state machine: per-chat BOT_ACTIVE ⇄ OWNER_FROZEN.
 *
 * Plan: the interlocutor writes → the bot answers and runs the conversation.
 * The owner types manually → the bot goes silent and the chat is "frozen". If
 * the interlocutor writes and the owner does not answer within
 * `ownerReplyWindowMs`, the bot re-engages. A message the bot itself sent (see
 * `identity.ts`) must never be mistaken for the owner and must not freeze the
 * chat — the caller resolves bot-vs-owner before calling {@link onOwnerMessage}.
 *
 * The `observer` sub-mode has no freezing (the model sees everyone and the reply
 * decision is the model's, via the tools), so this machine is only consulted in
 * `takeover`; {@link botMayReply} unifies both for callers.
 *
 * Pure and deterministic: an injectable {@link Clock} drives a dedicated
 * {@link TimerRegistry} of owner-reply windows, so it is unit-tested with a fake
 * clock and carries no Pi/grammY dependency.
 */

import {
	type Clock,
	systemClock,
	TIMER,
	TimerRegistry,
} from "../../core/timers";
import type { ManagerSubMode } from "../../storage/singleton-store";

export type TakeoverState = "bot_active" | "owner_frozen";

export interface TakeoverOptions {
	/** How long the owner has to answer before the bot re-engages (plan 300000). */
	ownerReplyWindowMs: number;
	clock?: Clock;
}

export class TakeoverMachine {
	private readonly states = new Map<string, TakeoverState>();
	private readonly timers: TimerRegistry;
	private readonly clock: Clock;
	private readonly ownerReplyWindowMs: number;

	constructor(options: TakeoverOptions) {
		this.clock = options.clock ?? systemClock;
		this.ownerReplyWindowMs = options.ownerReplyWindowMs;
		this.timers = new TimerRegistry(this.clock);
	}

	/** Current state for a chat (defaults to bot_active — the bot leads). */
	stateOf(chatId: string): TakeoverState {
		return this.states.get(chatId) ?? "bot_active";
	}

	isFrozen(chatId: string): boolean {
		return this.stateOf(chatId) === "owner_frozen";
	}

	/**
	 * An interlocutor message arrived. While frozen it starts the owner-reply
	 * window (the owner gets first crack); if they stay silent, {@link onTick}
	 * later re-engages the bot. While active it is a no-op.
	 */
	onInterlocutorMessage(chatId: string): void {
		if (this.isFrozen(chatId)) {
			this.timers.arm(chatId, TIMER.ownerReply, this.ownerReplyWindowMs);
		}
	}

	/**
	 * A message the owner typed manually arrived (the caller has already ruled out
	 * the bot's own sends). Freeze the chat and cancel any pending owner-reply
	 * window — the owner is handling it.
	 */
	onOwnerMessage(chatId: string): void {
		this.states.set(chatId, "owner_frozen");
		this.timers.cancel(chatId, TIMER.ownerReply);
	}

	/**
	 * Advance time: re-engage the bot on every chat whose owner-reply window has
	 * expired. Returns the chat ids that just unfroze.
	 */
	onTick(): string[] {
		const unfrozen: string[] = [];
		for (const entry of this.timers.collectDue()) {
			if (entry.name === TIMER.ownerReply) {
				this.states.set(entry.chatId, "bot_active");
				unfrozen.push(entry.chatId);
			}
		}
		return unfrozen;
	}

	/** Forget a chat entirely (cleared/closed). */
	remove(chatId: string): void {
		this.states.delete(chatId);
		this.timers.cancelChat(chatId);
	}
}

/**
 * Whether the bot is allowed to answer this chat right now. In `observer` the
 * bot may always answer (the model decides via the tools); in `takeover` only
 * while the chat is not frozen by the owner.
 */
export function botMayReply(
	subMode: ManagerSubMode,
	machine: TakeoverMachine,
	chatId: string,
): boolean {
	if (subMode === "observer") return true;
	return !machine.isFrozen(chatId);
}
