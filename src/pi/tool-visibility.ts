/**
 * Gate this extension's tools so the model only sees a mode's tools while that
 * mode is active — and never sees the *other* mode's tools.
 *
 * Tools are grouped (`connect` → `telegram_*`, `manager` → `manager_*`). Pi has
 * no per-turn unregister; instead `pi.setActiveTools(names)` sets the whole
 * active list. So we register every tool at load, then keep each group's gated
 * names and, on refresh, recompute the active list = all tools minus the names
 * of every group that is *not* active. Activating mode 1 reveals only its tools;
 * the manager's `manager_reply`/`manager_silent` stay hidden until mode 2 runs.
 * Mirrors pi-planner's `index.tool-visibility.ts`.
 *
 * IMPORTANT: `getAllTools()` / `setActiveTools()` are action methods that must
 * NOT be called during extension load. `registerToolVisibility` therefore only
 * refreshes on `session_start` and before each provider request.
 */
import type { ExtensionAPI } from "./sdk";

/** The tool-registry slice the controller needs; `ExtensionAPI` satisfies it. */
export interface ToolRegistryApi {
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): void;
}

/** Named groups of gated tool names. */
export type ToolGroups = Record<string, Iterable<string>>;

/** Tool names hidden right now: those belonging to any inactive group. */
export function hiddenToolNames(
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
): Set<string> {
	const hidden = new Set<string>();
	for (const [group, names] of groups) {
		if (activeGroups.has(group)) continue;
		for (const name of names) hidden.add(name);
	}
	return hidden;
}

/** All tool names, minus those in inactive groups. */
export function visibleToolNames(
	allToolNames: readonly string[],
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
): string[] {
	const hidden = hiddenToolNames(groups, activeGroups);
	return allToolNames.filter((name) => !hidden.has(name));
}

export interface ToolVisibility {
	/** Re-apply the active tool list from the current active state. */
	refresh(): void;
	/** Set whether a group's mode is active, then re-apply. */
	setActive(group: string, active: boolean): void;
	isActive(group: string): boolean;
}

/** Create a visibility controller over the tool registry for the given groups. */
export function createToolVisibility(
	api: ToolRegistryApi,
	groups: ToolGroups,
): ToolVisibility {
	const groupMap = new Map<string, Set<string>>();
	for (const [group, names] of Object.entries(groups)) {
		groupMap.set(group, new Set(names));
	}
	const activeGroups = new Set<string>();
	const refresh = (): void => {
		const all = api.getAllTools().map((tool) => tool.name);
		api.setActiveTools(visibleToolNames(all, groupMap, activeGroups));
	};
	return {
		refresh,
		setActive(group: string, active: boolean): void {
			if (active) activeGroups.add(group);
			else activeGroups.delete(group);
			refresh();
		},
		isActive(group: string): boolean {
			return activeGroups.has(group);
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
