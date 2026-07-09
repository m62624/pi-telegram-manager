import type { ExtensionContext } from "./sdk";

/**
 * The subset of `ExtensionContext` the bridge domains actually use. Narrowing
 * to a port keeps the domains SDK-free and lets tests drive them with a plain
 * object.
 */
export interface ContextPort {
	cwd: string;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	abort(): void;
	compact(): void;
}

export function toContextPort(ctx: ExtensionContext): ContextPort {
	return {
		cwd: ctx.cwd,
		isIdle: () => ctx.isIdle(),
		hasPendingMessages: () => ctx.hasPendingMessages(),
		abort: () => ctx.abort(),
		compact: () => ctx.compact(),
	};
}

/**
 * Holds the most recent `ExtensionContext` seen from a lifecycle event.
 *
 * The Telegram poll loop runs outside any event handler, but still needs to
 * query `isIdle()` / call `abort()` on the live turn. Lifecycle hooks update
 * this holder on each event (`agent_start`, `agent_end`, …); the loop reads the
 * latest port. Cleared on session shutdown so a torn-down context is never used.
 */
export class LatestContext {
	private ctx: ExtensionContext | undefined;

	set(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	clear(): void {
		this.ctx = undefined;
	}

	get(): ExtensionContext | undefined {
		return this.ctx;
	}

	port(): ContextPort | undefined {
		return this.ctx ? toContextPort(this.ctx) : undefined;
	}
}
