/**
 * Pure escalation policy for the Telegram connection watchdog.
 *
 * While a mode is active the runtime probes the bot connection (a lightweight
 * getMe call) every `intervalMs`. A healthy probe resets the failure streak; a
 * failed one increments it. grammY's poller reconnects on its own between probes,
 * so the watchdog's job is only to give it a bounded grace window and then give
 * up: this decides what to do at `failures` consecutive failed probes —
 *  - `wait`       — still within grace; keep letting the connection recover;
 *  - `disconnect` — the streak hit the limit; tear the mode down (auto-disconnect).
 *
 * Kept a pure function so the policy is unit-tested without timers or a live bot.
 */
export type WatchdogVerdict = "wait" | "disconnect";

/**
 * @param failures Consecutive failed probes so far (>= 1 when called).
 * @param maxRetries Failed probes tolerated before auto-disconnect (min 1).
 */
export function watchdogVerdict(
	failures: number,
	maxRetries: number,
): WatchdogVerdict {
	return failures >= Math.max(1, maxRetries) ? "disconnect" : "wait";
}
