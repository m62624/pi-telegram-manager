import { describe, expect, it } from "vitest";
import {
	TELEGRAM_BOT_COMMANDS,
	TELEGRAM_PUBLIC_COMMANDS,
} from "../src/constants";

describe("command menus", () => {
	it("offers strangers nothing but the terms", () => {
		// The default-scope menu is what anyone who opens the bot sees. Control
		// commands are refused to them anyway, so advertising them only puts a "Stop
		// the bot entirely" button in front of someone it will never obey.
		expect(TELEGRAM_PUBLIC_COMMANDS.map((c) => c.command)).toEqual(["start"]);
	});

	it("keeps every control command out of the public menu", () => {
		const publicCommands = new Set(
			TELEGRAM_PUBLIC_COMMANDS.map((c) => c.command),
		);
		for (const control of ["stop", "switch", "clear", "esc"]) {
			expect(publicCommands.has(control)).toBe(false);
			// …while the owner's own menu still carries them.
			expect(TELEGRAM_BOT_COMMANDS.some((c) => c.command === control)).toBe(
				true,
			);
		}
	});
});
