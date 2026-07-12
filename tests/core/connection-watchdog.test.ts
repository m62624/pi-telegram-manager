import { describe, expect, it } from "vitest";
import { watchdogVerdict } from "../../src/core/connection-watchdog";

describe("watchdogVerdict", () => {
	it("waits while the failure streak is below the limit", () => {
		expect(watchdogVerdict(1, 3)).toBe("wait");
		expect(watchdogVerdict(2, 3)).toBe("wait");
	});

	it("disconnects once the streak reaches the limit", () => {
		expect(watchdogVerdict(3, 3)).toBe("disconnect");
		expect(watchdogVerdict(4, 3)).toBe("disconnect");
	});

	it("needs at least one failure even if maxRetries is misconfigured to 0", () => {
		expect(watchdogVerdict(0, 0)).toBe("wait");
		expect(watchdogVerdict(1, 0)).toBe("disconnect");
	});
});
