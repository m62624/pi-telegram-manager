/**
 * "Did the agent actually take the message?" — a question we have to answer ourselves,
 * because Pi will not.
 *
 * `pi.sendUserMessage` returns `void`. It is fire-and-forget: the SDK keeps the promise,
 * swallows any rejection, and reports it through its own error channel. So `await`ing it
 * is theatre — it awaits `undefined` and always "succeeds".
 *
 * And it does fail. `agent.prompt()` throws "Agent is already processing a prompt"
 * whenever the previous run has not finished unwinding — which is precisely the state
 * the manager leaves behind, because it aborts at the end of every turn. The session
 * reports itself idle (that flag is cleared early), the run is not, the prompt is thrown
 * away, and the bridge — believing the message delivered, because the call did not
 * complain — drops it from the queue. That is a message the owner sent and nobody ever
 * answered, and the only trace of it is a line in Pi's log:
 *
 *     Extension "<runtime>" error: Agent is already processing a prompt.
 *
 * A prompt that was really accepted starts a turn, and a turn that starts fires
 * `agent_start`. So that is what delivery is confirmed by. A message that never produced
 * one is not delivered: it stays queued, and it is tried again.
 *
 * No timers of its own beyond the one it awaits, no SDK, no I/O.
 */
export class TurnSignal {
	private readonly waiting = new Set<(started: boolean) => void>();

	/** A turn has started (`agent_start`). Everyone waiting for one is told. */
	fire(): void {
		const waiters = [...this.waiting];
		this.waiting.clear();
		for (const resolve of waiters) resolve(true);
	}

	/**
	 * Whether a turn starts within `timeoutMs`. False means the prompt never became a
	 * turn — nothing is running, and nothing is going to.
	 */
	next(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const waiter = (started: boolean): void => {
				clearTimeout(timer);
				resolve(started);
			};
			const timer = setTimeout(() => {
				this.waiting.delete(waiter);
				resolve(false);
			}, timeoutMs);
			this.waiting.add(waiter);
		});
	}

	/** The mode is going down: release every waiter rather than leave it hanging. */
	clear(): void {
		const waiters = [...this.waiting];
		this.waiting.clear();
		for (const resolve of waiters) resolve(false);
	}

	/** How many hand-offs are waiting for confirmation (for tests). */
	get pending(): number {
		return this.waiting.size;
	}
}
