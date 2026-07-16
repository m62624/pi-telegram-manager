import type { ExtensionCommandContext, ExtensionContext } from "./sdk";

/** How often to re-check idleness, and the hard cap so a wait can never hang forever. */
const IDLE_POLL_MS = 100;
const IDLE_POLL_CAP_MS = 10 * 60_000;

/**
 * Present a base {@link ExtensionContext} as an {@link ExtensionCommandContext} for the
 * bridge runtime.
 *
 * A bridge re-armed after a session switch runs from a `session_start`, which hands a
 * BASE context (no `waitForIdle`/`newSession`/…). But the whole runtime needs a command
 * context in exactly ONE place: `ctx.waitForIdle()` in the queue pump's settle wait (the
 * only such call in the extension). The base context has no settle promise, so we
 * substitute a poll of `isIdle()` — good enough because every hand-off also
 * confirms-and-retries. The session-control methods are never reached on this path, so
 * they are inert stubs that exist only to satisfy the type.
 *
 * Everything else (ui, sessionManager, cwd, isIdle, getContextUsage, the live `signal`
 * getter, …) is forwarded straight to the base context.
 */
export function commandContextFromBase(
	base: ExtensionContext,
): ExtensionCommandContext {
	const overrides: Record<string | symbol, unknown> = {
		waitForIdle: () => pollUntilIdle(base),
		getSystemPromptOptions: () => ({ cwd: base.cwd }),
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};
	return new Proxy(base as object, {
		get(target, prop) {
			if (prop in overrides) return overrides[prop];
			const value = Reflect.get(target, prop, target);
			// Bind methods to the base, not the proxy, so `this` inside them is intact.
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as ExtensionCommandContext;
}

async function pollUntilIdle(
	ctx: Pick<ExtensionContext, "isIdle">,
): Promise<void> {
	const start = Date.now();
	while (!ctx.isIdle() && Date.now() - start < IDLE_POLL_CAP_MS) {
		await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
	}
}
