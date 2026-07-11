import { describe, expect, it } from "vitest";
import { bullet, card, note } from "../../../src/modes/connect/format";

describe("connect format helpers", () => {
	it("bullet renders label and optional description", () => {
		expect(bullet("/esc")).toBe("• /esc");
		expect(bullet("/esc", "cancel")).toBe("• /esc — cancel");
	});

	it("note italicises text", () => {
		expect(note("idle")).toBe("_idle_");
	});

	it("card is a bare header with no body", () => {
		expect(card("✅", "Done")).toBe("✅ *Done*");
	});

	it("card puts a blank line before a bulleted body", () => {
		expect(card("🧭", "Help", [bullet("/esc", "cancel")])).toBe(
			"🧭 *Help*\n\n• /esc — cancel",
		);
	});
});
