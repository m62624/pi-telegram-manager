import { describe, expect, it } from "vitest";
import {
	humanBytes,
	humanMs,
	renderSettingsReport,
} from "../../src/core/settings-report";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../src/settings/schema";

const SECRET = "7654321:AAH-super-secret-token";

const withToken = normalizeSettings({
	botToken: SECRET,
	allowedUserId: 777,
});

describe("renderSettingsReport", () => {
	it("NEVER prints the token — not even a fragment of it", () => {
		for (const mode of ["personal", "manager", "mixed"] as const) {
			const report = renderSettingsReport({ settings: withToken, mode });
			expect(report).not.toContain(SECRET);
			expect(report).not.toContain("AAH");
			expect(report).not.toContain("7654321");
			// Only whether one exists at all.
			expect(report).toContain("bot token: set (never shown)");
		}
	});

	it("says a token is missing without inventing one", () => {
		const report = renderSettingsReport({
			settings: DEFAULT_SETTINGS,
			mode: "personal",
		});
		expect(report).toContain("bot token: not set");
	});

	it("leads with the thing that is easiest to get wrong", () => {
		// The whole reason this exists: a setting cannot be changed from a chat.
		const report = renderSettingsReport({
			settings: withToken,
			mode: "manager",
		});
		expect(report).toContain("restart the");
		expect(report).toContain("Do not tell anyone a setting has been changed");
	});

	it("reports the running mode's own settings", () => {
		const personal = renderSettingsReport({
			settings: withToken,
			mode: "personal",
		});
		expect(personal).toContain("Personal mode");
		expect(personal).not.toContain("Manager mode");

		const manager = renderSettingsReport({
			settings: withToken,
			mode: "manager",
		});
		expect(manager).toContain("Manager mode");
		expect(manager).not.toContain("## Personal mode");

		// Mixed is both, and says how long the owner must be quiet.
		const mixed = renderSettingsReport({ settings: withToken, mode: "mixed" });
		expect(mixed).toContain("Personal mode");
		expect(mixed).toContain("Manager mode");
		expect(mixed).toContain("Mixed mode");
	});

	it("renders values a person can read, not raw milliseconds and bytes", () => {
		const report = renderSettingsReport({ settings: withToken, mode: "mixed" });
		expect(report).toContain("owner reply window: 5 min");
		expect(report).toContain("continuation window: 2 min");
		expect(report).toContain("attach a tool's full output up to: 25 MiB");
		expect(report).not.toContain("300000");
		expect(report).not.toContain("26214400");
	});

	it("names the defaults instead of leaving a blank", () => {
		const report = renderSettingsReport({
			settings: withToken,
			mode: "personal",
		});
		expect(report).toContain(
			"files you send are saved to: the directory Pi runs in",
		);
		expect(report).toContain(
			"tool output written to: the extension's own directory",
		);
	});

	it("says plainly when the sandbox has been widened", () => {
		const widened = normalizeSettings({
			manager: { allowedTools: ["bash", "read"] },
		});
		const report = renderSettingsReport({ settings: widened, mode: "manager" });
		expect(report).toContain("extra tools allowed in the sandbox: bash, read");

		const closed = renderSettingsReport({
			settings: withToken,
			mode: "manager",
		});
		expect(closed).toContain("none (messaging tools only)");
	});
});

describe("humanMs / humanBytes", () => {
	it("reads like a person wrote it", () => {
		expect(humanMs(0)).toBe("off");
		expect(humanMs(800)).toBe("800 ms");
		expect(humanMs(45_000)).toBe("45 s");
		expect(humanMs(300_000)).toBe("5 min");
		expect(humanMs(90_000)).toBe("1 min 30 s");
		expect(humanMs(36_000_000)).toBe("10 h");

		expect(humanBytes(0)).toBe("off");
		expect(humanBytes(900)).toBe("900 B");
		expect(humanBytes(1_048_576)).toBe("1 MiB");
		expect(humanBytes(26_214_400)).toBe("25 MiB");
		expect(humanBytes(52_428_800)).toBe("50 MiB");
	});
});
