import { describe, expect, it } from "vitest";
import {
	createToolVisibility,
	type ToolRegistryApi,
	visibleToolNames,
} from "../../src/pi/tool-visibility";

describe("visibleToolNames", () => {
	const all = ["read", "write", "telegram_message", "telegram_attach"];
	const gated = new Set(["telegram_message", "telegram_attach"]);

	it("hides gated tools when inactive", () => {
		expect(visibleToolNames(all, gated, false)).toEqual(["read", "write"]);
	});

	it("shows every tool when active", () => {
		expect(visibleToolNames(all, gated, true)).toEqual(all);
	});

	it("is a no-op when nothing is gated", () => {
		expect(visibleToolNames(all, new Set(), false)).toEqual(all);
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

	it("defaults to inactive: gated tools are hidden on first refresh", () => {
		const api = fakeApi(["read", "telegram_message"]);
		const visibility = createToolVisibility(api, ["telegram_message"]);
		expect(visibility.isActive()).toBe(false);
		visibility.refresh();
		expect(api.active).toEqual(["read"]);
	});

	it("reveals gated tools once active and hides them again when deactivated", () => {
		const api = fakeApi(["read", "telegram_message"]);
		const visibility = createToolVisibility(api, ["telegram_message"]);

		visibility.setActive(true);
		expect(api.active).toEqual(["read", "telegram_message"]);

		visibility.setActive(false);
		expect(api.active).toEqual(["read"]);
	});

	it("picks up tools registered after construction on refresh", () => {
		const api = fakeApi(["read"]);
		const visibility = createToolVisibility(api, ["telegram_message"]);
		visibility.setActive(true);
		// A tool registered later shows up because refresh re-reads getAllTools.
		api.getAllTools = () => [{ name: "read" }, { name: "telegram_message" }];
		visibility.refresh();
		expect(api.active).toEqual(["read", "telegram_message"]);
	});
});
