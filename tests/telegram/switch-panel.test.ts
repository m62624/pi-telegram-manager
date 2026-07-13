import { describe, expect, it } from "vitest";
import {
	buildSwitchKeyboard,
	isStopCommand,
	isSwitchCommand,
	parseSwitchData,
	type SwitchTarget,
	switchLabel,
	switchPanelText,
} from "../../src/telegram/switch-panel";

const PANEL_TARGETS: SwitchTarget[] = ["manager", "mixed", "personal"];

describe("buildSwitchKeyboard", () => {
	it("renders the three selectable modes with their switch:<target> callback data", () => {
		const keyboard = buildSwitchKeyboard("manager");
		const buttons = keyboard.inline_keyboard.flat();
		expect(buttons.map((b) => b.callback_data)).toEqual([
			"switch:manager",
			"switch:mixed",
			"switch:personal",
		]);
	});

	it("offers no stop button — stopping is the explicit /stop command", () => {
		const buttons = buildSwitchKeyboard("manager").inline_keyboard.flat();
		expect(buttons.some((b) => b.callback_data === "switch:stop")).toBe(false);
	});

	it("lays the buttons out two per row", () => {
		const keyboard = buildSwitchKeyboard("stop");
		expect(keyboard.inline_keyboard).toHaveLength(2);
		expect(keyboard.inline_keyboard[0]).toHaveLength(2);
		expect(keyboard.inline_keyboard[1]).toHaveLength(1);
	});

	it("marks only the active mode with a check", () => {
		for (const active of PANEL_TARGETS) {
			const buttons = buildSwitchKeyboard(active).inline_keyboard.flat();
			const checked = buttons.filter((b) => b.text.startsWith("✅"));
			expect(checked).toHaveLength(1);
			expect(checked[0].callback_data).toBe(`switch:${active}`);
		}
	});

	it("checks nothing when the bot is stopped — no button represents that", () => {
		const buttons = buildSwitchKeyboard("stop").inline_keyboard.flat();
		expect(buttons.filter((b) => b.text.startsWith("✅"))).toHaveLength(0);
	});
});

describe("switchPanelText / switchLabel", () => {
	it("names the active mode in the caption", () => {
		expect(switchPanelText("manager")).toContain("🎛️ Manager");
		expect(switchPanelText("personal")).toContain("🤖 Personal");
	});

	it("points at /stop, which no button offers", () => {
		expect(switchPanelText("manager")).toContain("/stop");
	});

	it("labels every target with an emoji", () => {
		expect(switchLabel("manager")).toBe("🎛️ Manager");
		expect(switchLabel("mixed")).toBe("🔀 Mixed");
		expect(switchLabel("stop")).toBe("⏹️ Stop");
	});
});

describe("isSwitchCommand", () => {
	it("matches a bare /switch and a /switch@bot suffix, case-insensitively", () => {
		expect(isSwitchCommand("/switch")).toBe(true);
		expect(isSwitchCommand("  /Switch  ")).toBe(true);
		expect(isSwitchCommand("/switch@MyBot")).toBe(true);
	});

	it("rejects prose and commands that merely start with switch", () => {
		expect(isSwitchCommand("/switcher")).toBe(false);
		expect(isSwitchCommand("switch")).toBe(false);
		expect(isSwitchCommand("/switch now")).toBe(false);
		expect(isSwitchCommand("please /switch")).toBe(false);
	});
});

describe("isStopCommand", () => {
	it("matches a bare /stop and a /stop@bot suffix, case-insensitively", () => {
		expect(isStopCommand("/stop")).toBe(true);
		expect(isStopCommand("  /Stop  ")).toBe(true);
		expect(isStopCommand("/stop@MyBot")).toBe(true);
	});

	it("rejects prose and near-misses, so it cannot fire by accident", () => {
		expect(isStopCommand("/stopped")).toBe(false);
		expect(isStopCommand("stop")).toBe(false);
		expect(isStopCommand("/stop the bot")).toBe(false);
		expect(isStopCommand("please /stop")).toBe(false);
	});
});

describe("parseSwitchData", () => {
	it("parses a valid switch:<target> payload", () => {
		expect(parseSwitchData("switch:manager")).toBe("manager");
		expect(parseSwitchData("switch:mixed")).toBe("mixed");
	});

	it("ignores switch:stop — an old panel's stop button must not kill the bot", () => {
		expect(parseSwitchData("switch:stop")).toBeNull();
	});

	it("returns null for missing, foreign, or unknown-target data", () => {
		expect(parseSwitchData(undefined)).toBeNull();
		expect(parseSwitchData("")).toBeNull();
		expect(parseSwitchData("other:manager")).toBeNull();
		expect(parseSwitchData("switch:bogus")).toBeNull();
		expect(parseSwitchData("switch:")).toBeNull();
	});
});
