import { describe, expect, it } from "vitest";
import { formatNowLine } from "../../src/core/datetime";

// 2026-07-10T09:32:00Z — a Friday in UTC.
const T = Date.UTC(2026, 6, 10, 9, 32, 0);

describe("formatNowLine", () => {
	it("renders weekday, ISO date, 24h time and offset in UTC", () => {
		expect(formatNowLine(T, "UTC")).toBe("[Now: Fri 2026-07-10 09:32 +00:00]");
	});

	it("shifts the wall time and offset for a positive-offset zone", () => {
		// Almaty is UTC+5 → 14:32 same day.
		expect(formatNowLine(T, "Asia/Almaty")).toBe(
			"[Now: Fri 2026-07-10 14:32 +05:00]",
		);
	});

	it("falls back to system time on an invalid timezone instead of throwing", () => {
		expect(() => formatNowLine(T, "Not/AZone")).not.toThrow();
		expect(formatNowLine(T, "Not/AZone")).toMatch(
			/^\[Now: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}\]$/,
		);
	});
});
