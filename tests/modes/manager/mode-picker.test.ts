import { describe, expect, it, vi } from "vitest";
import {
	modeOptions,
	selectMode,
} from "../../../src/modes/manager/mode-picker";

function ui(pick: (options: string[]) => string | undefined) {
	const select = vi.fn(async (_title: string, options: string[]) =>
		pick(options),
	);
	return { ui: { select }, select };
}

describe("modeOptions", () => {
	it("lists every mode and marks the one running", () => {
		const options = modeOptions("mixed-observer", true);
		expect(options).toHaveLength(7); // 6 modes + the DM panel
		expect(options.filter((o) => o.includes("← active"))).toEqual([
			expect.stringContaining("mixed · observer"),
		]);
	});

	it("offers the DM panel only while a bot is polling to receive it", () => {
		expect(modeOptions("stop", false).some((o) => o.startsWith("panel"))).toBe(
			false,
		);
		expect(modeOptions("stop", true).some((o) => o.startsWith("panel"))).toBe(
			true,
		);
	});
});

describe("selectMode", () => {
	it("resolves the picked mode, marker and all", async () => {
		// The live mode's label carries "← active"; picking it must still resolve.
		const { ui: u } = ui((options) =>
			options.find((o) => o.startsWith("takeover")),
		);
		expect(await selectMode(u, "takeover", true)).toBe("takeover");
	});

	it("resolves each mode by its own label", async () => {
		for (const [prefix, expected] of [
			["personal", "personal"],
			["observer", "observer"],
			["mixed · observer", "mixed-observer"],
			["mixed · takeover", "mixed-takeover"],
			["stop", "stop"],
		] as const) {
			const { ui: u } = ui((options) =>
				options.find((o) => o.startsWith(prefix)),
			);
			expect(await selectMode(u, "stop", false)).toBe(expected);
		}
	});

	it("resolves the DM panel option", async () => {
		const { ui: u } = ui((options) =>
			options.find((o) => o.startsWith("panel")),
		);
		expect(await selectMode(u, "personal", true)).toBe("panel");
	});

	it("returns null when the dialog is dismissed", async () => {
		const { ui: u } = ui(() => undefined);
		expect(await selectMode(u, "stop", true)).toBeNull();
	});
});
