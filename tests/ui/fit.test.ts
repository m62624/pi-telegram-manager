import { describe, expect, it } from "vitest";
import { fitLine, fitLines, terminalWidth } from "../../src/ui/fit";

describe("fitLine", () => {
	it("leaves a line that fits untouched", () => {
		expect(fitLine("mixed · observer · coding", 40)).toBe(
			"mixed · observer · coding",
		);
	});

	it("clips an over-long line to the width, ellipsis included", () => {
		const fitted = fitLine("⚠️ Telegram MANAGER is running here", 12);
		expect([...fitted]).toHaveLength(12);
		expect(fitted.endsWith("…")).toBe(true);
	});

	it("never lays out below the floor, however narrow the terminal claims to be", () => {
		// A 0/1-column terminal must still yield something rather than break layout.
		expect([...fitLine("Telegram: connected", 0)]).toHaveLength(8);
		expect([...fitLine("Telegram: connected", -5)]).toHaveLength(8);
	});

	it("counts code points, so a glyph is never cut in half", () => {
		// Twelve emoji clipped to ten: nine survive whole, then the ellipsis.
		expect(fitLine("😀".repeat(12), 10)).toBe(`${"😀".repeat(9)}…`);
	});

	it("strips what desyncs fixed-width layout: tabs, CR, ANSI, control bytes", () => {
		expect(fitLine("a\tb", 20)).toBe("a  b");
		expect(fitLine("a\rb", 20)).toBe("ab");
		expect(fitLine("[31mred[0m", 20)).toBe("red");
		expect(fitLine("ab", 20)).toBe("ab");
	});
});

describe("fitLines", () => {
	it("fits every line of a widget", () => {
		const lines = fitLines(["a".repeat(40), "short"], 10);
		expect([...lines[0]]).toHaveLength(10);
		expect(lines[1]).toBe("short");
	});
});

describe("terminalWidth", () => {
	it("falls back when the process reports no columns (not a TTY)", () => {
		expect(terminalWidth(72)).toBeGreaterThan(0);
	});
});
