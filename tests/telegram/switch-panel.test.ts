import { describe, expect, it } from "vitest";
import {
	buildSwitchKeyboard,
	isSwitchCommand,
	parseSwitchData,
	type SwitchTarget,
	switchLabel,
	switchPanelText,
} from "../../src/telegram/switch-panel";

const TARGETS: SwitchTarget[] = [
	"observer",
	"takeover",
	"mixed-observer",
	"mixed-takeover",
	"personal",
	"stop",
];

describe("buildSwitchKeyboard", () => {
	it("renders all six modes with their switch:<target> callback data", () => {
		const keyboard = buildSwitchKeyboard("observer");
		const buttons = keyboard.inline_keyboard.flat();
		expect(buttons).toHaveLength(6);
		expect(buttons.map((b) => b.callback_data)).toEqual([
			"switch:observer",
			"switch:takeover",
			"switch:mixed-observer",
			"switch:mixed-takeover",
			"switch:personal",
			"switch:stop",
		]);
	});

	it("lays the buttons out two per row", () => {
		const keyboard = buildSwitchKeyboard("stop");
		expect(keyboard.inline_keyboard).toHaveLength(3);
		for (const row of keyboard.inline_keyboard) expect(row).toHaveLength(2);
	});

	it("marks only the active mode with a check (incl. mixed sub-modes)", () => {
		for (const active of TARGETS) {
			const buttons = buildSwitchKeyboard(active).inline_keyboard.flat();
			const checked = buttons.filter((b) => b.text.startsWith("✅"));
			expect(checked).toHaveLength(1);
			expect(checked[0].callback_data).toBe(`switch:${active}`);
		}
	});
});

describe("switchPanelText / switchLabel", () => {
	it("names the active mode in the caption", () => {
		expect(switchPanelText("takeover")).toContain("🎛️ Takeover");
		expect(switchPanelText("personal")).toContain("🤖 Personal");
	});

	it("labels every target with an emoji", () => {
		expect(switchLabel("observer")).toBe("👁️ Observer");
		expect(switchLabel("stop")).toBe("⏹️ Stop");
	});

	it("labels and checks the mixed sub-mode targets", () => {
		expect(switchLabel("mixed-observer")).toBe("🔀 Mixed · Observer");
		expect(switchLabel("mixed-takeover")).toBe("🔀 Mixed · Takeover");
		expect(switchPanelText("mixed-observer")).toContain("🔀 Mixed · Observer");
		const buttons =
			buildSwitchKeyboard("mixed-takeover").inline_keyboard.flat();
		const checked = buttons.filter((b) => b.text.startsWith("✅"));
		expect(checked).toHaveLength(1);
		expect(checked[0].callback_data).toBe("switch:mixed-takeover");
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

describe("parseSwitchData", () => {
	it("parses a valid switch:<target> payload", () => {
		expect(parseSwitchData("switch:observer")).toBe("observer");
		expect(parseSwitchData("switch:stop")).toBe("stop");
	});

	it("returns null for missing, foreign, or unknown-target data", () => {
		expect(parseSwitchData(undefined)).toBeNull();
		expect(parseSwitchData("")).toBeNull();
		expect(parseSwitchData("other:observer")).toBeNull();
		expect(parseSwitchData("switch:bogus")).toBeNull();
		expect(parseSwitchData("switch:")).toBeNull();
	});
});
