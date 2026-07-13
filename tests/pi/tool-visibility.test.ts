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
	function fakeApi(names: string[]): ToolRegistryApi & { active: string[] } {
		return {
			active: [...names],
			getAllTools() {
				return names.map((name) => ({ name }));
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

	function fakeApi(): ToolRegistryApi & { active: string[] } {
		return {
			active: [],
			getAllTools: () => ALL.map((name) => ({ name })),
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
