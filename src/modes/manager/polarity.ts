/**
 * Mixed-mode polarity invariants — the single source of truth for "who owns the
 * shared brain right now" and everything derived from it.
 *
 * Mixed mode runs the manager runtime and the owner's terminal session in ONE Pi
 * session. A `polarity` says which side the brain is serving: `coding` (the owner
 * is at the terminal — full tools, clean thread, Telegram deferred) or `telegram`
 * (the owner is idle — the manager moderates in its sandbox). The standalone
 * manager (mode 2) behaves as if it always holds the session.
 *
 * The composition root (`index.ts`) MUST derive every polarity-dependent decision
 * from {@link managerHoldsSession} so the behaviours can never drift apart:
 *  - whether the manager may run a turn (its `isIdle`);
 *  - whether the manager tool sandbox is the active exclusive tool set;
 *  - whether the runtime tool guard blocks non-sandbox tools;
 *  - whether `turn_end`/`agent_end` treat the finished turn as the manager's;
 *  - which source builds the LLM context (see {@link mixedContextSource}).
 *
 * Pure and dependency-free, so the whole truth table is unit-tested.
 */

export type Polarity = "coding" | "telegram";

/**
 * Whether the manager (Telegram side) owns the shared session's turn right now.
 *
 * Non-mixed manager mode always holds the session (`mixedActive === false`). In
 * mixed mode the manager holds it only in the `telegram` polarity; during
 * `coding` the owner owns the session, so the manager stays out (its tools are
 * hidden, its turns are gated, its context filter runs).
 */
export function managerHoldsSession(
	mixedActive: boolean,
	polarity: Polarity,
): boolean {
	return !mixedActive || polarity === "telegram";
}

/**
 * Whether the runtime tool guard should block non-sandbox tools this instant.
 * True only when the manager is actually running AND holds the session — so in
 * mixed mode's coding polarity the owner keeps full tools (hardware safety only
 * applies while the manager is driving).
 */
export function managerGuardActive(
	managerRunning: boolean,
	mixedActive: boolean,
	polarity: Polarity,
): boolean {
	return managerRunning && managerHoldsSession(mixedActive, polarity);
}

/** Which transcript builds the LLM context for the current turn. */
export type ContextSource =
	/** The active Telegram chat's isolated history (manager / mixed-telegram). */
	| "manager-chat"
	/** The owner's real session messages with Telegram turns stripped (mixed-coding). */
	| "coding-filtered"
	/** Leave the context untouched (no manager running). */
	| "untouched";

/**
 * The context source for a turn, given whether the manager is running and the
 * mixed-mode polarity. Mirrors {@link managerHoldsSession}: when the manager
 * holds the session the model sees the active chat; in mixed-coding it sees the
 * filtered coding thread; otherwise the context is left as-is.
 */
export function mixedContextSource(
	managerRunning: boolean,
	mixedActive: boolean,
	polarity: Polarity,
): ContextSource {
	if (mixedActive) {
		return managerHoldsSession(mixedActive, polarity)
			? "manager-chat"
			: "coding-filtered";
	}
	return managerRunning ? "manager-chat" : "untouched";
}
