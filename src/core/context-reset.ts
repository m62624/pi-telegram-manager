/**
 * A soft "clear history" boundary for the agent's context.
 *
 * Telegram has no native "the user cleared the chat" update, so a fresh start
 * is driven by a `/clear` bot command. Rather than rewrite the session file, we
 * record a boundary timestamp and, on every `context` event (fired before each
 * LLM call), drop the messages older than it — so the model stops seeing the
 * prior conversation while the on-disk history stays intact.
 *
 * This is the same reducer planned for mode-2 per-chat isolation, here applied
 * to mode 1's single shared session (so a mode-1 `/clear` also clears what the
 * terminal side sees — one shared context). It is a pure, injectable-clock unit
 * with no SDK/grammY dependency; `index.ts` registers `pi.on("context")` and
 * feeds it `event.messages`.
 */

/** The only field of an agent message this reducer needs. */
export interface ContextMessageLike {
	timestamp?: number;
}

export class ContextReset {
	private boundary: number | null = null;

	/** Mark everything up to `now` as cleared; the model won't see it anymore. */
	clear(now: number): void {
		this.boundary = now;
	}

	/** Drop the boundary (e.g. on disconnect), restoring the full history. */
	forget(): void {
		this.boundary = null;
	}

	/** Whether a clear boundary is currently in effect. */
	isActive(): boolean {
		return this.boundary !== null;
	}

	/**
	 * Filter messages to those at or after the boundary. Returns `undefined`
	 * when no boundary is set — the caller should then leave the context
	 * untouched rather than replace it with an identical array.
	 */
	apply<T extends ContextMessageLike>(messages: readonly T[]): T[] | undefined {
		if (this.boundary === null) return undefined;
		const cutoff = this.boundary;
		return messages.filter((message) => (message.timestamp ?? 0) >= cutoff);
	}
}
