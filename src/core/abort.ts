/**
 * Holds the current turn's abort handler.
 *
 * On `agent_start` a controller stores `() => ctx.abort()`; the Telegram
 * `/abort`, `/stop`, and `/next` commands invoke it to interrupt the running
 * turn; on `agent_end` the controller clears it. Keeping this in one small,
 * injectable object (rather than a loose variable) makes the interrupt path
 * testable and avoids a name clash with the global `AbortController`.
 */

export type AbortHandler = () => void | Promise<void>;

export class AbortRegistry {
	private handler: AbortHandler | null = null;

	/** Arm the handler for the turn that just started (replaces any previous one). */
	set(handler: AbortHandler): void {
		this.handler = handler;
	}

	/** Disarm — called when the turn ends. */
	clear(): void {
		this.handler = null;
	}

	isArmed(): boolean {
		return this.handler !== null;
	}

	/** Invoke the armed handler. Returns false (a no-op) when nothing is running. */
	async abort(): Promise<boolean> {
		if (!this.handler) return false;
		await this.handler();
		return true;
	}
}
