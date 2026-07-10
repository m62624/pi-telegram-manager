/**
 * The single decision "may the model call this tool while the telegram-sandbox
 * (manager mode) is active?".
 *
 * The manager runs as a deny-all sandbox: the model may only call its own
 * messaging tools (`manager_reply`/`manager_silent`) plus whatever tool names
 * the user re-enabled through `manager.allowedTools` — an array of regular
 * expressions matched against tool names. Everything else (built-in
 * `read`/`write`/`bash`, `ask_user`, any other extension's tools) is blocked.
 *
 * One matcher instance is shared by both enforcement layers so they can never
 * disagree: the visibility gate ({@link ./tool-visibility}) hides disallowed
 * tools from the model, and the runtime guard ({@link ./tool-guard}) blocks any
 * disallowed call that still slips through. Patterns are anchored (`^(?:…)$`) so
 * `read` does not match `thread`; an invalid pattern is reported and skipped
 * rather than crashing the session.
 */
export interface ToolMatcher {
	matches(name: string): boolean;
}

/**
 * Build a matcher from a fixed set of always-allowed names plus user regex
 * patterns. Invalid patterns are passed to `onWarn` and dropped.
 */
export function createToolMatcher(
	allowedNames: Iterable<string>,
	patterns: readonly string[] = [],
	onWarn?: (message: string) => void,
): ToolMatcher {
	const names = new Set(allowedNames);
	const regexes: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			regexes.push(new RegExp(`^(?:${pattern})$`));
		} catch (error) {
			onWarn?.(
				`Ignoring invalid manager.allowedTools pattern ${JSON.stringify(
					pattern,
				)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {
		matches(name: string): boolean {
			return names.has(name) || regexes.some((re) => re.test(name));
		},
	};
}
