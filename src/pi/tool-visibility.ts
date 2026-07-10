/**
 * Gate this extension's tools so the model only sees `telegram_*` /
 * `manager_*` tools while a Telegram mode is actually active.
 *
 * Pi has no per-turn unregister; instead `pi.setActiveTools(names)` sets the
 * whole active tool list. So we register every tool at load, then keep a set of
 * *our* gated names and, whenever visibility needs refreshing, recompute the
 * active list = all tools minus our gated ones (when inactive) or all tools
 * (when active). Mirrors pi-planner's `index.tool-visibility.ts`.
 *
 * IMPORTANT: `getAllTools()` / `setActiveTools()` are action methods that must
 * NOT be called during extension load. `registerToolVisibility` therefore only
 * refreshes on `session_start` and before each provider request — the same
 * safe points pi-planner uses.
 */
import type { ExtensionAPI } from "./sdk";

/** The tool-registry slice the controller needs; `ExtensionAPI` satisfies it. */
export interface ToolRegistryApi {
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): void;
}

/** All tool names, minus the gated ones when inactive. */
export function visibleToolNames(
	allToolNames: readonly string[],
	gatedToolNames: ReadonlySet<string>,
	active: boolean,
): string[] {
	if (active) return [...allToolNames];
	return allToolNames.filter((name) => !gatedToolNames.has(name));
}

export interface ToolVisibility {
	/** Re-apply the active tool list from the current active state. */
	refresh(): void;
	/** Set whether a Telegram mode is active, then re-apply. */
	setActive(active: boolean): void;
	isActive(): boolean;
}

/** Create a visibility controller over the tool registry, gating `gated` names. */
export function createToolVisibility(
	api: ToolRegistryApi,
	gated: Iterable<string>,
): ToolVisibility {
	const gatedSet = new Set(gated);
	let active = false;
	const refresh = (): void => {
		const all = api.getAllTools().map((tool) => tool.name);
		api.setActiveTools(visibleToolNames(all, gatedSet, active));
	};
	return {
		refresh,
		setActive(next: boolean): void {
			active = next;
			refresh();
		},
		isActive(): boolean {
			return active;
		},
	};
}

/**
 * Keep tool visibility correct across a session's life. Refreshes on
 * `session_start` (a fresh/resumed session defaults to inactive → tools hidden)
 * and before every provider request (so the model never sees a stale set).
 */
export function registerToolVisibility(
	pi: ExtensionAPI,
	visibility: ToolVisibility,
): void {
	pi.on("session_start", async () => {
		visibility.refresh();
	});
	pi.on("before_provider_request", async () => {
		visibility.refresh();
	});
}
