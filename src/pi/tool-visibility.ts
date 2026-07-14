/**
 * Gate this extension's tools so the model only sees a mode's tools while that
 * mode is active — and never sees the *other* mode's tools.
 *
 * Tools are grouped (`connect` → `telegram_*`, `manager` → `manager_*`). Pi has
 * no per-turn unregister; instead `pi.setActiveTools(names)` sets the whole
 * active list. So we register every tool at load, then keep each group's gated
 * names and, on refresh, recompute the active list.
 *
 * Two shapes of gating:
 *  - **Additive** (`connect`): active list = all tools minus the names of every
 *    group that is *not* active. Activating mode 1 reveals its tools alongside
 *    the rest.
 *  - **Exclusive** (`manager`, the telegram-sandbox): when active, the active
 *    list is *only* the tools its {@link ToolMatcher} allows — the group's own
 *    `manager_*` tools plus any `manager.allowedTools` regex matches. Every other
 *    tool (built-in `read`/`write`/`bash`, `ask_user`, foreign extensions') is
 *    hidden. The matcher is injected at activation via {@link setExclusive}
 *    because the allowlist comes from settings, loaded after extension load.
 *
 * IMPORTANT: `getAllTools()` / `setActiveTools()` are action methods that must
 * NOT be called during extension load. `registerToolVisibility` therefore only
 * refreshes on `session_start` and before each provider request.
 */

import type { ExtensionAPI } from "./sdk";
import type { ToolMatcher } from "./tool-allow";

/** The tool-registry slice the controller needs; `ExtensionAPI` satisfies it. */
export interface ToolRegistryApi {
	getAllTools(): { name: string }[];
	/** What the world allows RIGHT NOW — including whatever other extensions decided. */
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

/** Named groups of gated tool names. */
export type ToolGroups = Record<string, Iterable<string>>;

/** Tool names claimed by an ACTIVE group — ours, and they must be reachable. */
export function claimedToolNames(
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
): Set<string> {
	const claimed = new Set<string>();
	for (const group of activeGroups) {
		for (const name of groups.get(group) ?? []) claimed.add(name);
	}
	return claimed;
}

/**
 * The active list to apply, computed as a SUBTRACTION from what is already active rather
 * than as a fresh recomputation of the world. This distinction is the whole file.
 *
 * `setActiveTools` is a global setter with no notion of "someone else's tools": whoever
 * writes last wins the entire list. We rebuilt it from `getAllTools()`, and so does
 * `pi-planner` (`updateToolVisibility`: `getAllTools()` → everything minus `planner_*` →
 * `setActiveTools`). Two extensions each declaring the whole world, on every request, is
 * not a race — it is a war, and the owner's prompt was the battlefield:
 *
 *   - our list resurrected the 54 `planner_*` tools the planner had just hidden;
 *   - the planner's list resurrected the 8 `manager_*` tools we had just hidden — so in
 *     PERSONAL mode the model could see `manager_reply`;
 *   - and the head of the prompt, where the tool schemas live, changed between two calls
 *     of one turn: ~24k tokens, then ~10k. The backend threw away everything it had read.
 *     Measured in the owner's session: prefill 24 302 → 11 653, cache 24 348 → 0.
 *
 * So we stop declaring the world. We enforce our own invariants and nothing else:
 *
 *   next = (what is active now  ∪  what our active groups claim)  \  what we hide
 *
 * Nobody's tools are resurrected by us again. And it CONVERGES: the planner sets
 * `all − planner_*`; we subtract `manager_*`; next turn the planner computes the same
 * thing and we subtract the same thing. A fixed point — which is what a prefix cache
 * needs, because a stable set of tools is a stable head, and a stable head is a prompt
 * the backend does not have to read twice.
 *
 * Order is part of the bytes: the same tools in a different order are a different head.
 * So the result is built by walking the registry, whose order does not move.
 */
export function subtractedToolNames(
	allToolNames: readonly string[],
	activeNow: readonly string[],
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
): string[] {
	const active = new Set(activeNow);
	const claimed = claimedToolNames(groups, activeGroups);
	const hidden = hiddenToolNames(groups, activeGroups);
	return allToolNames.filter(
		(name) => (active.has(name) || claimed.has(name)) && !hidden.has(name),
	);
}

/**
 * Tool names hidden right now: those belonging to an inactive group AND to no
 * active one.
 *
 * A tool may be listed by more than one group — `telegram_bot_about` belongs to
 * both, because it must be reachable in every mode. Hiding by group alone made the
 * inactive group win: in personal mode the (inactive) manager group hid a tool the
 * (active) connect group had just claimed, and the model could not see it at all.
 * Membership of an active group is a claim, and it beats the absence of one.
 */
export function hiddenToolNames(
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
): Set<string> {
	const claimed = new Set<string>();
	for (const group of activeGroups) {
		for (const name of groups.get(group) ?? []) claimed.add(name);
	}
	const hidden = new Set<string>();
	for (const [group, names] of groups) {
		if (activeGroups.has(group)) continue;
		for (const name of names) {
			if (!claimed.has(name)) hidden.add(name);
		}
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

/**
 * The active tool list.
 *
 * Two rules, and the difference between them is the difference between a subtraction and
 * an allowlist:
 *
 *  - **Sandboxed** (an active group is exclusive): the list is EXACTLY what the matcher
 *    allows, taken from the registry. A sandbox is not "the world, minus some things" —
 *    it is a closed set, and it must stay closed no matter what another extension has
 *    just decided the world should contain. This is what keeps `pi-planner`'s tools (or
 *    anyone's) out of a Telegram turn.
 *  - **Otherwise**: a subtraction from what is active right now
 *    ({@link subtractedToolNames}) — we hide ours, claim ours, and leave everyone else's
 *    decisions alone.
 *
 * `activeNow` is what the world currently allows. In the sandboxed case it is ignored on
 * purpose; the caller passes the world it remembers from before the sandbox went up, so
 * the sandbox cannot poison what comes after it.
 */
export function computeActiveTools(
	allToolNames: readonly string[],
	activeNow: readonly string[],
	groups: ReadonlyMap<string, ReadonlySet<string>>,
	activeGroups: ReadonlySet<string>,
	exclusive: ReadonlyMap<string, ToolMatcher>,
): string[] {
	const activeExclusive = [...activeGroups]
		.filter((group) => exclusive.has(group))
		.map((group) => exclusive.get(group) as ToolMatcher);
	if (activeExclusive.length > 0) {
		return allToolNames.filter((name) =>
			activeExclusive.some((matcher) => matcher.matches(name)),
		);
	}
	return subtractedToolNames(allToolNames, activeNow, groups, activeGroups);
}

export interface ToolVisibility {
	/** Re-apply the active tool list from the current active state. */
	refresh(): void;
	/** Set whether a group's mode is active, then re-apply. */
	setActive(group: string, active: boolean): void;
	isActive(group: string): boolean;
	/**
	 * Mark a group as exclusive with the given matcher (deny-all except matcher),
	 * or pass `null` to clear it back to additive. Re-applies immediately.
	 */
	setExclusive(group: string, matcher: ToolMatcher | null): void;
	/**
	 * The exact list we last wrote, or `null` before the first refresh — our own
	 * footprint on a global setter.
	 *
	 * `setActiveTools` has no notion of whose tools are whose, so a tool list arriving at
	 * the provider is not self-evidently ours: another extension may have written after
	 * us. Someone has to be able to ask "is this what WE decided?", and only the writer
	 * can answer it. The prefix watchdog asks (`core/payload-probe.ts`): a prompt head
	 * that changes mid-run is a defect when a stranger changed it, and merely a cost we
	 * chose when we did.
	 */
	lastSet(): string[] | null;
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
	const exclusive = new Map<string, ToolMatcher>();
	/**
	 * The world as it was before a sandbox went up — everything the other extensions were
	 * allowing, at the last moment we could still see it.
	 *
	 * While the sandbox is up, the live list IS the sandbox (six tools), so "subtract from
	 * what is active" has nothing left to subtract from: come out of the sandbox reading
	 * the live list and the owner's terminal would be left with no tools at all. So the
	 * world is remembered on the way in and restored on the way out — and whoever changed
	 * their mind while we were away (the planner moving to another stage) re-asserts it on
	 * their next refresh, which is one turn later, and self-heals.
	 */
	let worldBeforeSandbox: string[] | null = null;
	/** The last list we handed `setActiveTools` — see {@link ToolVisibility.lastSet}. */
	let written: string[] | null = null;
	const sandboxed = (): boolean =>
		[...activeGroups].some((group) => exclusive.has(group));
	const refresh = (): void => {
		const all = api.getAllTools().map((tool) => tool.name);
		const sandbox = sandboxed();
		// Going in, and only the first time: the live list is about to become the sandbox,
		// so this is the last look at the world we are going to get.
		if (sandbox) worldBeforeSandbox ??= api.getActiveTools();
		// Coming out, the world to subtract from is the one we remembered on the way in.
		// Otherwise it is simply what is active now, whoever put it there.
		const activeNow = worldBeforeSandbox ?? api.getActiveTools();
		if (!sandbox) worldBeforeSandbox = null;
		const next = computeActiveTools(
			all,
			activeNow,
			groupMap,
			activeGroups,
			exclusive,
		);
		written = next;
		api.setActiveTools(next);
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
		setExclusive(group: string, matcher: ToolMatcher | null): void {
			if (matcher) exclusive.set(group, matcher);
			else exclusive.delete(group);
			refresh();
		},
		lastSet(): string[] | null {
			return written === null ? null : [...written];
		},
	};
}

/**
 * Keep tool visibility correct across a session's life.
 *
 * WHEN it refreshes is the whole point, and getting it wrong is invisible in review,
 * so the timing is written down here.
 *
 * A run does not read the tool list per request. `Agent.runPromptMessages` takes ONE
 * snapshot (`createContextSnapshot()` — `tools: this._state.tools.slice()`) before the
 * loop starts, and every LLM call in that run uses it. Between turns, and only there,
 * `AgentSession._installAgentNextTurnRefresh` re-reads `agent.state.tools` into the
 * context. So `setActiveTools` — which writes `agent.state.tools` — lands on the next
 * TURN, never on the request in flight. Pi's own doc-comment says exactly that:
 * "Changes take effect on the next agent turn."
 *
 * This used to refresh on `before_provider_request`, which is `onPayload`: it runs when
 * the payload for the current request is already built. Every refresh therefore arrived
 * one LLM call too late, and the first call of every run went out with the tool list of
 * the run before it. That is not academic — it is the bug the owner caught: a memory pass
 * opened with the reply tools still listed, the model looked for the interrogation tool
 * the directive named, could not find it, and reasoned aloud that the tool "does not
 * exist"; it then called a blocked tool, was steered, and only on the SECOND call — the
 * first one to see a fresh list — did the pass actually start. The same lag hit the
 * revise turn (whose directive had to plead "it IS available, whatever you assume about
 * your tool list") and the first reply turn after a memory pass.
 *
 * Two hooks, both landing before a snapshot is taken:
 *  - `session_start` — a fresh/resumed session defaults to inactive → tools hidden;
 *  - `before_agent_start` — emitted inside `prompt()` BEFORE `agent.prompt()`, so the
 *    run's snapshot picks it up. This is the one that fixes the first call of a run.
 *
 * The other end — a tool set that must change BETWEEN turns of one run (the memory pass
 * walks its whole interrogation in a single run) — is not hooked here: it belongs to
 * whoever advances that state, and `index.ts` calls {@link ToolVisibility.refresh} at the
 * end of its own `turn_end` handler, after the step it just took. Registering a second
 * `turn_end` handler here would race that one on registration order.
 */
export function registerToolVisibility(
	pi: ExtensionAPI,
	visibility: ToolVisibility,
): void {
	pi.on("session_start", async () => {
		visibility.refresh();
	});
	pi.on("before_agent_start", async () => {
		visibility.refresh();
		return undefined;
	});
}
