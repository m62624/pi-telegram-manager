/**
 * A one-at-a-time lane for work whose ORDER is what the reader sees.
 *
 * Pi delivers extension events fire-and-forget (`void runner.emit(event)`): a handler
 * is called, and the next event does not wait for it to finish. Every send we make is
 * therefore a race against the sends that come after it — and the loser is always the
 * slow one. Uploading a tool's 50 KB log takes seconds; posting the answer that
 * follows takes milliseconds. So the answer arrived first and the log landed under it,
 * quoting a tool card from further up the chat: the turn read back-to-front.
 *
 * Handing every chat-visible step to this lane restores the terminal's own order —
 * card, output, card, output, answer — because the lane runs one task at a time, in
 * the order the tasks were handed over. The ONLY thing that matters is that a task is
 * handed over synchronously, inside the event handler, before its first `await`:
 * that is what pins it to the position its event had.
 *
 * A task that throws does not stop the lane: the chat must not go silent because one
 * upload failed. Its rejection is handed back to whoever queued it, and the lane
 * carries on with the next task.
 */

export interface SerialLane {
	/**
	 * Queue `task` behind everything queued before it. The returned promise settles
	 * with the task's own result — including its rejection, which the caller is
	 * expected to handle (the lane itself never fails).
	 */
	run<T>(task: () => Promise<T>): Promise<T>;
	/** Resolve once everything queued SO FAR has finished (successfully or not). */
	drain(): Promise<void>;
	/** How many tasks are queued or running — i.e. how far behind the chat is. */
	pending(): number;
}

export function createSerialLane(): SerialLane {
	// Always-settling tail of the chain: the next task hangs off this, so a failure
	// never breaks the link.
	let tail: Promise<void> = Promise.resolve();
	let pending = 0;

	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			pending += 1;
			const run = tail.then(task);
			tail = run.then(
				() => {
					pending -= 1;
				},
				() => {
					pending -= 1;
				},
			);
			return run;
		},
		drain: () => tail,
		pending: () => pending,
	};
}
