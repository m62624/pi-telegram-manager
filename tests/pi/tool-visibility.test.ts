import { describe, expect, it } from "vitest";
import { ABOUT_TOOL_NAMES } from "../../src/core/about";
import { TELEGRAM_TOOL_NAMES } from "../../src/core/attachments";
import { managerHoldsSession } from "../../src/modes/manager/polarity";
import { createToolMatcher } from "../../src/pi/tool-allow";
import {
	createToolVisibility,
	type ToolRegistryApi,
	visibleToolNames,
} from "../../src/pi/tool-visibility";

const groupMap = (obj: Record<string, string[]>) =>
	new Map(Object.entries(obj).map(([g, names]) => [g, new Set(names)]));

describe("visibleToolNames", () => {
	const all = ["read", "write", "telegram_message", "manager_reply"];
	const groups = groupMap({
		connect: ["telegram_message"],
		manager: ["manager_reply"],
	});

	it("hides every group's tools when nothing is active", () => {
		expect(visibleToolNames(all, groups, new Set())).toEqual(["read", "write"]);
	});

	it("shows only the active group's tools", () => {
		expect(visibleToolNames(all, groups, new Set(["connect"]))).toEqual([
			"read",
			"write",
			"telegram_message",
		]);
		expect(visibleToolNames(all, groups, new Set(["manager"]))).toEqual([
			"read",
			"write",
			"manager_reply",
		]);
	});

	it("shows a tool BOTH groups claim, whichever one is active", () => {
		// Live bug: `telegram_bot_about` is listed by connect AND manager, because it
		// must work in every mode. Hiding by group alone let the INACTIVE group win —
		// in personal mode the manager group hid a tool connect had just claimed, and
		// the model reported it "not registered in this session".
		const shared = ["read", "telegram_bot_about", "manager_reply"];
		const bothGroups = groupMap({
			connect: ["telegram_bot_about"],
			manager: ["telegram_bot_about", "manager_reply"],
		});

		expect(visibleToolNames(shared, bothGroups, new Set(["connect"]))).toEqual([
			"read",
			"telegram_bot_about",
		]);
		expect(visibleToolNames(shared, bothGroups, new Set(["manager"]))).toEqual(
			shared,
		);
		// Still hidden when neither mode is running.
		expect(visibleToolNames(shared, bothGroups, new Set())).toEqual(["read"]);
	});
});

describe("createToolVisibility", () => {
	/**
	 * The registry as Pi really behaves: `getActiveTools()` returns what is active RIGHT
	 * NOW — which includes whatever another extension set a moment ago. That is the whole
	 * reason this file changed: the list is shared, and we are not its only author.
	 *
	 * A fresh session starts with everything active, which is what Pi does.
	 */
	function fakeApi(names: string[]): ToolRegistryApi & { active: string[] } {
		return {
			active: [...names],
			getAllTools() {
				return names.map((name) => ({ name }));
			},
			getActiveTools() {
				return [...this.active];
			},
			setActiveTools(next) {
				this.active = next;
			},
		};
	}

	it("hides all gated groups on first refresh", () => {
		const api = fakeApi(["read", "telegram_message", "manager_reply"]);
		const visibility = createToolVisibility(api, {
			connect: ["telegram_message"],
			manager: ["manager_reply"],
		});
		visibility.refresh();
		expect(api.active).toEqual(["read"]);
	});

	it("reveals only the active group and never the other mode's tools", () => {
		const api = fakeApi(["read", "telegram_message", "manager_reply"]);
		const visibility = createToolVisibility(api, {
			connect: ["telegram_message"],
			manager: ["manager_reply"],
		});

		visibility.setActive("connect", true);
		expect(api.active).toEqual(["read", "telegram_message"]);
		expect(visibility.isActive("connect")).toBe(true);
		expect(visibility.isActive("manager")).toBe(false);

		visibility.setActive("connect", false);
		visibility.setActive("manager", true);
		expect(api.active).toEqual(["read", "manager_reply"]);
	});

	it("exclusive manager collapses to only its allowlist (telegram-sandbox)", () => {
		const api = fakeApi([
			"read",
			"write",
			"bash",
			"ask_user",
			"telegram_message",
			"manager_reply",
			"manager_silent",
		]);
		const visibility = createToolVisibility(api, {
			connect: ["telegram_message"],
			manager: ["manager_reply", "manager_silent"],
		});
		visibility.setExclusive(
			"manager",
			createToolMatcher(["manager_reply", "manager_silent"]),
		);
		visibility.setActive("manager", true);
		expect(api.active).toEqual(["manager_reply", "manager_silent"]);
	});

	it("manager allowedTools regex re-enables specific tools only", () => {
		const api = fakeApi([
			"read",
			"bash",
			"grep",
			"manager_reply",
			"manager_silent",
		]);
		const visibility = createToolVisibility(api, {
			manager: ["manager_reply", "manager_silent"],
		});
		visibility.setExclusive(
			"manager",
			createToolMatcher(["manager_reply", "manager_silent"], ["^grep$"]),
		);
		visibility.setActive("manager", true);
		expect(api.active).toEqual(["grep", "manager_reply", "manager_silent"]);
	});

	// The owner's rule: telegram_attach is the personal side's tool. It exists while
	// the owner is being served (Personal, and the coding polarity of mixed) and is
	// gone the moment the manager holds the session — the secretary must not be able
	// to push files at anyone. In mixed both groups are active at once, so this is
	// the only place the rule is actually decided.
	it("hides telegram_attach whenever the manager holds the session (mixed)", () => {
		const api = fakeApi(["read", "telegram_attach", "manager_reply"]);
		const visibility = createToolVisibility(api, {
			connect: [...TELEGRAM_TOOL_NAMES],
			manager: ["manager_reply"],
		});
		visibility.setExclusive("manager", createToolMatcher(["manager_reply"]));
		visibility.setActive("connect", true);

		for (const polarity of ["coding", "telegram"] as const) {
			visibility.setActive("manager", managerHoldsSession(true, polarity));
			expect(api.active.includes("telegram_attach")).toBe(
				polarity === "coding",
			);
		}
	});

	it("clearing exclusive returns to additive visibility", () => {
		const api = fakeApi(["read", "manager_reply"]);
		const visibility = createToolVisibility(api, {
			manager: ["manager_reply"],
		});
		visibility.setExclusive("manager", createToolMatcher(["manager_reply"]));
		visibility.setActive("manager", true);
		expect(api.active).toEqual(["manager_reply"]);
		visibility.setExclusive("manager", null);
		expect(api.active).toEqual(["read", "manager_reply"]);
	});
});

describe("the real group wiring (index.ts)", () => {
	// Exactly what index.ts registers, so the sandbox is tested as it actually runs.
	const CONNECT_GROUP = [...TELEGRAM_TOOL_NAMES, ...ABOUT_TOOL_NAMES];
	const MANAGER_GROUP = [
		"manager_reply",
		"manager_silent",
		"manager_remember",
		"manager_skip",
		...ABOUT_TOOL_NAMES,
	];
	const ALL = [
		"read",
		"write",
		"bash",
		"ask_user",
		...TELEGRAM_TOOL_NAMES,
		...ABOUT_TOOL_NAMES,
		"manager_reply",
		"manager_silent",
		"manager_remember",
		"manager_skip",
	];

	/** A fresh Pi session starts with every registered tool active. */
	function fakeApi(): ToolRegistryApi & { active: string[] } {
		return {
			active: [...ALL],
			getAllTools: () => ALL.map((name) => ({ name })),
			getActiveTools() {
				return [...this.active];
			},
			setActiveTools(next) {
				this.active = next;
			},
		};
	}

	it("gives personal mode its own tools AND the about tool", () => {
		// The bug this pins: `telegram_bot_about` is claimed by both groups, and the
		// inactive manager group used to hide it from personal mode entirely.
		const api = fakeApi();
		const visibility = createToolVisibility(api, {
			connect: CONNECT_GROUP,
			manager: MANAGER_GROUP,
		});
		visibility.setActive("connect", true);

		expect(api.active).toContain("telegram_bot_about");
		expect(api.active).toContain("telegram_attach");
		// The owner's own coding tools stay available: this is their machine.
		expect(api.active).toContain("bash");
		// The other mode's tools do not leak in.
		expect(api.active).not.toContain("manager_reply");
	});

	it("gives the manager ONLY messaging + about — nothing from personal mode", () => {
		const api = fakeApi();
		const visibility = createToolVisibility(api, {
			connect: CONNECT_GROUP,
			manager: MANAGER_GROUP,
		});
		// The sandbox: an exclusive matcher over the manager group, as index.ts builds it.
		visibility.setExclusive("manager", createToolMatcher(MANAGER_GROUP, []));
		visibility.setActive("manager", true);

		expect(api.active.sort()).toEqual([...MANAGER_GROUP].sort());
		// Nothing that touches the owner's computer, and nothing of mode 1's.
		for (const forbidden of [
			"read",
			"write",
			"bash",
			"ask_user",
			"telegram_attach",
		]) {
			expect(api.active).not.toContain(forbidden);
		}
	});

	it("keeps the sandbox closed even while personal mode is also active (mixed)", () => {
		// Mixed, Telegram polarity: connect is active too, but an exclusive group wins.
		const api = fakeApi();
		const visibility = createToolVisibility(api, {
			connect: CONNECT_GROUP,
			manager: MANAGER_GROUP,
		});
		visibility.setExclusive("manager", createToolMatcher(MANAGER_GROUP, []));
		visibility.setActive("connect", true);
		visibility.setActive("manager", true);

		expect(api.active).not.toContain("bash");
		expect(api.active).not.toContain("telegram_attach");
		expect(api.active).toContain("telegram_bot_about");
	});
});

/**
 * The other extensions.
 *
 * `setActiveTools` is a GLOBAL setter: it replaces the whole list, and it has no notion of
 * whose tools are whose. We are not its only author — `pi-planner` rebuilds the entire list
 * from `getAllTools()` on every `before_provider_request`, and `pi-approval-modes` can do
 * the same. Two extensions each declaring the whole world, on every request, is not a race.
 * It is a war, and it was fought in the owner's prompt:
 *
 *   - our list resurrected the 54 `planner_*` tools the planner had just hidden;
 *   - the planner's list resurrected the 8 `manager_*` tools we had just hidden — so in
 *     PERSONAL mode the model was shown `manager_reply`;
 *   - and the head of the prompt (where the tool schemas live, ahead of every message)
 *     changed between two calls of ONE turn. Measured: prefill 24 302 → 11 653,
 *     cache 24 348 → 0. The backend threw away everything it had read.
 *
 * So these tests do not ask "does our gate work in a quiet room". They put a rival in the
 * room, let it write last on every request, and demand three things anyway: the sandbox
 * holds, the other mode's tools never appear, and the list stops moving.
 */
describe("living with another extension that also owns the tool list", () => {
	const PLANNER = ["planner_status", "planner_reason", "planner_exec"];
	const CONNECT_GROUP = [...TELEGRAM_TOOL_NAMES, ...ABOUT_TOOL_NAMES];
	const MANAGER_GROUP = [
		"manager_reply",
		"manager_silent",
		...ABOUT_TOOL_NAMES,
	];
	const ALL = [
		"read",
		"write",
		"bash",
		...PLANNER,
		...TELEGRAM_TOOL_NAMES,
		...ABOUT_TOOL_NAMES,
		"manager_reply",
		"manager_silent",
	];

	/**
	 * A registry with a rival extension living in it. `rivalRefresh()` is `pi-planner`'s
	 * `updateToolVisibility`, verbatim in shape: read EVERY registered tool, drop its own,
	 * write the whole list back — trampling anything anyone else had hidden.
	 */
	function world() {
		const api: ToolRegistryApi & { active: string[] } = {
			active: [...ALL],
			getAllTools: () => ALL.map((name) => ({ name })),
			getActiveTools() {
				return [...this.active];
			},
			setActiveTools(next) {
				this.active = next;
			},
		};
		/** What the planner does on every provider request, when no plan is running. */
		const rivalRefresh = (): void => {
			api.setActiveTools(
				api
					.getAllTools()
					.map((t) => t.name)
					.filter((n) => !PLANNER.includes(n)),
			);
		};
		return { api, rivalRefresh };
	}

	const gate = (api: ToolRegistryApi) =>
		createToolVisibility(api, {
			connect: CONNECT_GROUP,
			manager: MANAGER_GROUP,
		});

	it("never lets a rival resurrect the manager tools into the owner's DM", () => {
		// The live symptom: `/context` reported the head had `gained manager_reply,
		// manager_silent, …` in PERSONAL mode. The planner put them back, because it does
		// not know they are ours to hide.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		visibility.setActive("connect", true);

		rivalRefresh(); // the planner writes during the request
		expect(api.active).toContain("manager_reply"); // …and it really does resurrect them

		visibility.refresh(); // we write at turn_end — after it, and last
		expect(api.active).not.toContain("manager_reply");
		expect(api.active).not.toContain("manager_silent");
		expect(api.active).toContain("telegram_attach");
		expect(api.active).toContain("bash"); // the owner's own machine, untouched
	});

	it("does not resurrect the rival's tools either — we subtract, we do not rebuild", () => {
		// The other half of the war, and the half that was OURS. Rebuilding the list from
		// `getAllTools()` put the planner's tools back every time it hid them, so the two of
		// us swapped 14k tokens of schemas in and out of the head of the prompt, forever.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		visibility.setActive("connect", true);

		rivalRefresh(); // planner hides its own tools: it is not running a plan
		visibility.refresh();

		for (const name of PLANNER) expect(api.active).not.toContain(name);
	});

	it("reaches a fixed point — which is what a prefix cache actually needs", () => {
		// A stable set of tools is a stable head, and a stable head is a prompt the backend
		// does not have to read twice. Convergence is not an aesthetic property here: it is
		// the feature.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		visibility.setActive("connect", true);

		const heads: string[] = [];
		for (let turn = 0; turn < 5; turn += 1) {
			rivalRefresh(); // the request
			visibility.refresh(); // turn_end — we have the last word
			heads.push(api.active.join(","));
		}
		expect(new Set(heads).size).toBe(1); // it never moves again
	});

	it("keeps the sandbox closed even when the rival writes last on every request", () => {
		// Security first, and it may not depend on the order extensions happen to load in.
		// A sandbox is not "the world minus some things" — it is a closed set, and it stays
		// closed no matter what anyone else has just decided the world should contain.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		visibility.setActive("manager", true);
		visibility.setExclusive("manager", createToolMatcher(MANAGER_GROUP, []));

		for (let turn = 0; turn < 3; turn += 1) {
			rivalRefresh(); // the rival hands the sandbox read/write/bash on a plate
			visibility.refresh(); // and we take them straight back
			for (const forbidden of ["read", "write", "bash", ...PLANNER]) {
				expect(api.active).not.toContain(forbidden);
			}
			expect(api.active).toContain("manager_reply");
			expect(api.active).toContain("telegram_bot_about");
		}
	});

	it("gives the world back when the sandbox comes down", () => {
		// While the sandbox is up, the live list IS the sandbox — so "subtract from what is
		// active" would have nothing left to subtract from, and the owner's terminal would
		// come out of a Telegram turn with no tools at all. The world is remembered on the
		// way in and restored on the way out.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		visibility.setActive("connect", true);
		rivalRefresh();
		visibility.refresh();
		const before = [...api.active];

		visibility.setActive("manager", true);
		visibility.setExclusive("manager", createToolMatcher(MANAGER_GROUP, []));
		expect(api.active).not.toContain("bash");

		visibility.setExclusive("manager", null);
		visibility.setActive("manager", false);
		expect(api.active).toEqual(before); // exactly the world we left, nothing invented
		expect(api.active).toContain("bash");
		for (const name of PLANNER) expect(api.active).not.toContain(name);
	});

	it("remembers what WE wrote, so a rewrite can be attributed to whoever did it", () => {
		// `setActiveTools` is global and anonymous: a list arriving at the provider does not
		// say who put it there. The prefix watchdog has to ask, because a head rewritten by
		// a stranger is a bug and a head rewritten by us is a decision — and, told nothing,
		// it reported our own memory pass as an intrusion, once per pass, to the owner.
		const { api, rivalRefresh } = world();
		const visibility = gate(api);
		expect(visibility.lastSet()).toBeNull(); // nothing written yet: claim nothing

		visibility.setActive("connect", true);
		expect(visibility.lastSet()).toEqual(api.active); // ours, and it matches the world

		rivalRefresh(); // the planner writes over us
		expect(api.active).not.toEqual(visibility.lastSet()); // → attributable: not ours

		visibility.refresh(); // we get the last word back
		expect(visibility.lastSet()).toEqual(api.active);
	});

	it("hands out a copy, so nobody can edit our record of what we set", () => {
		const { api } = world();
		const visibility = gate(api);
		visibility.setActive("connect", true);
		const stolen = visibility.lastSet() as string[];
		stolen.push("intruder");
		expect(visibility.lastSet()).not.toContain("intruder");
	});
});
