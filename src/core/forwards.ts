/**
 * Policy for FORWARDED messages — content someone pasted in from elsewhere.
 *
 * A forward is not a message written to you: it is an arbitrary amount of other
 * people's text dropped into the conversation, and Telegram sends a batch of them
 * as one message each. Ten forwarded posts are ten messages, each of any length —
 * enough to blow a small local model's context on their own, and to hand a stranger
 * an easy way to fill it with whatever they like. So forwards get their own budget,
 * separate from the ordinary reply/quote context of the current chat:
 *
 *  - `maxChars` caps the body of ONE forwarded message (0 = no cap);
 *  - `maxMessages` caps how many forwards of a single BATCH are read at all
 *    (0 = no cap); the rest are acknowledged, not read;
 *  - `groupWindowMs` is what makes a batch a batch: consecutive forwards into the
 *    same chat, each within this window of the previous one, are one burst.
 *
 * This module is pure (no grammY, no I/O): both modes track their bursts through
 * {@link ForwardBursts} and render the same markers, so a forward wall reads the
 * same whether it lands in your own DM or in a chat the manager is answering.
 */

export interface ForwardPolicy {
	/** Longest body kept from one forwarded message; 0 = no cap. */
	maxChars: number;
	/** Forwarded messages read per batch; 0 = no cap. The rest are noted, not read. */
	maxMessages: number;
	/** Quiet gap that ends a batch. */
	groupWindowMs: number;
}

/**
 * The budget used when none is configured — deliberately generous enough for a
 * normal "look at this" forward and far too small for a wall of pasted posts.
 */
export const DEFAULT_FORWARD_POLICY: ForwardPolicy = {
	maxChars: 2000,
	maxMessages: 5,
	groupWindowMs: 3000,
};

/** What to do with one forwarded message, given the batch it belongs to. */
export interface ForwardSlot {
	/** Stable key of the batch — a group id for folding messages into one turn. */
	key: string;
	/** 1-based position of this message within its batch. */
	index: number;
	/** True once the batch is past `maxMessages`: the body must NOT be read. */
	overLimit: boolean;
	/** True for the first message that crosses the limit — the one that says so. */
	justHitLimit: boolean;
}

/**
 * Tracks the open forward batch per scope (a chat id). A non-forwarded message
 * closes the batch: the sender went back to talking, so the next forward starts a
 * new one.
 */
export class ForwardBursts {
	private readonly open = new Map<
		string,
		{ key: string; count: number; lastAt: number }
	>();
	private counter = 0;

	constructor(private readonly policy: ForwardPolicy) {}

	/**
	 * Place a message in the current batch. `null` for anything that is not a
	 * forward — which also closes the open batch for that scope.
	 */
	track(scope: string, isForward: boolean, now: number): ForwardSlot | null {
		if (!isForward) {
			this.open.delete(scope);
			return null;
		}
		const current = this.open.get(scope);
		const burst =
			current && now - current.lastAt <= this.policy.groupWindowMs
				? current
				: { key: `fwd-${this.counter++}`, count: 0, lastAt: now };
		burst.count += 1;
		burst.lastAt = now;
		this.open.set(scope, burst);
		const max = this.policy.maxMessages;
		const overLimit = max > 0 && burst.count > max;
		return {
			key: burst.key,
			index: burst.count,
			overLimit,
			justHitLimit: overLimit && burst.count === max + 1,
		};
	}

	/** Forget a scope's open batch (chat closed / mode stopped). */
	forget(scope: string): void {
		this.open.delete(scope);
	}
}

/** Cut a forwarded body down to the policy's budget, saying how much was cut. */
export function limitForwardText(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const cut = text.length - maxChars;
	return `${text.slice(0, maxChars)}…[+${cut} chars not read]`;
}

/**
 * The line that replaces the body of a forward the policy refused to read. Only the
 * FIRST such message in a batch carries it (`justHitLimit`); the ones after it are
 * dropped entirely, since repeating the same line would be the very flood the limit
 * exists to prevent.
 */
export function forwardLimitNote(read: number): string {
	return `[forward limit: ${read} forwarded message${read === 1 ? "" : "s"} read, the rest of this batch was not read]`;
}
