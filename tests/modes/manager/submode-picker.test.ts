import { describe, expect, it, vi } from "vitest";
import {
	OBSERVER_OPTION,
	selectManagerSubMode,
	TAKEOVER_OPTION,
} from "../../../src/modes/manager/submode-picker";

function fakeUi(returns: string | undefined) {
	return {
		select: vi.fn(async () => returns),
	};
}

describe("selectManagerSubMode", () => {
	it("returns observer when the observer option is picked", async () => {
		const ui = fakeUi(OBSERVER_OPTION);
		expect(await selectManagerSubMode(ui)).toBe("observer");
		expect(ui.select).toHaveBeenCalledWith("Telegram manager sub-mode", [
			OBSERVER_OPTION,
			TAKEOVER_OPTION,
		]);
	});

	it("returns takeover when the takeover option is picked", async () => {
		expect(await selectManagerSubMode(fakeUi(TAKEOVER_OPTION))).toBe(
			"takeover",
		);
	});

	it("returns null when the dialog is dismissed", async () => {
		expect(await selectManagerSubMode(fakeUi(undefined))).toBeNull();
	});

	it("honours a custom title", async () => {
		const ui = fakeUi(OBSERVER_OPTION);
		await selectManagerSubMode(ui, "Mixed mode sub-mode");
		expect(ui.select).toHaveBeenCalledWith("Mixed mode sub-mode", [
			OBSERVER_OPTION,
			TAKEOVER_OPTION,
		]);
	});
});
