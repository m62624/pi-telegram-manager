import { describe, expect, it } from "vitest";
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
});
