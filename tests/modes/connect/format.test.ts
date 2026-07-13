import { describe, expect, it } from "vitest";
import { bullet, card, link, note } from "../../../src/modes/connect/format";

describe("connect format helpers", () => {
	it("bullet renders a real Markdown list item, not a typed-out dot", () => {
		// A "•" line is prose: joined by single newlines, Markdown runs the whole
		// stack together into one paragraph. A list item stays a list item.
		expect(bullet("/esc")).toBe("- /esc");
		expect(bullet("/esc", "cancel")).toBe("- /esc — cancel");
	});

	it("note italicises text", () => {
		expect(note("idle")).toBe("_idle_");
	});

	it("link renders a Markdown link", () => {
		expect(link("GitHub", "https://example.com")).toBe(
			"[GitHub](https://example.com)",
		);
	});

	it("card is a bare bold header with no body", () => {
		expect(card("✅", "Done")).toBe("✅ **Done**");
	});

	it("card puts a blank line before a bulleted body", () => {
		expect(card("🧭", "Help", [bullet("/esc", "cancel")])).toBe(
			"🧭 **Help**\n\n- /esc — cancel",
		);
	});

	it("keeps consecutive bullets in ONE list, and separates other blocks by a blank line", () => {
		// The list must not be broken up (each item its own paragraph), and the prose
		// after it must not be glued to it — that glue is what made /help unreadable.
		expect(
			card("🧭", "Help", [
				bullet("/esc", "cancel"),
				bullet("/clear", "reset"),
				note("terminal only"),
				"Read the terms.",
			]),
		).toBe(
			"🧭 **Help**\n\n- /esc — cancel\n- /clear — reset\n\n_terminal only_\n\nRead the terms.",
		);
	});

	it("drops hand-made blank-line spacing from the body", () => {
		// Callers used to pass "" to force a gap; the card owns spacing now, and a
		// stray "" would otherwise become a paragraph of nothing.
		expect(card("✅", "Done", ["", bullet("a"), "", "tail", ""])).toBe(
			"✅ **Done**\n\n- a\n\ntail",
		);
	});
});
