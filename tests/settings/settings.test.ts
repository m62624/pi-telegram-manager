import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/settings/manager";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../src/settings/schema";
import { createTelegramPaths } from "../../src/storage/paths";
import { FakeFs } from "../helpers/fake-fs";

const paths = createTelegramPaths("/agent");

describe("normalizeSettings", () => {
	it("returns defaults for empty input", () => {
		expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it("field-merges over defaults, keeping untouched defaults", () => {
		const s = normalizeSettings({
			manager: { continueWindowMs: 45_000, subMode: "takeover" },
		});
		expect(s.manager.continueWindowMs).toBe(45_000);
		expect(s.manager.subMode).toBe("takeover");
		// Untouched fields keep defaults.
		expect(s.manager.ownerReplyWindowMs).toBe(300_000);
		expect(s.manager.labeler).toBe("LLM agent 🤖:");
	});

	it("accepts an empty labeler (no prefix)", () => {
		expect(
			normalizeSettings({ manager: { labeler: "" } }).manager.labeler,
		).toBe("");
	});

	it("collects unknown top-level keys as warnings without failing", () => {
		const warnings: string[] = [];
		normalizeSettings({ nope: 1, botToken: "x" }, warnings);
		expect(warnings.join()).toContain("nope");
	});

	it("throws TypeError with a path on a wrong-typed field", () => {
		expect(() =>
			normalizeSettings({ manager: { continueWindowMs: -5 } }),
		).toThrow(/manager.continueWindowMs/);
		expect(() =>
			normalizeSettings({ assistant: { rendering: "xml" } }),
		).toThrow(/assistant.rendering/);
		expect(() => normalizeSettings({ instructionFiles: "not-array" })).toThrow(
			/instructionFiles/,
		);
	});

	it("defaults connectionCheck to enabled/10min/3 and honours overrides", () => {
		expect(normalizeSettings({}).connectionCheck).toEqual({
			enabled: true,
			intervalMs: 600_000,
			maxRetries: 3,
		});
		const s = normalizeSettings({
			connectionCheck: { enabled: false, intervalMs: 0, maxRetries: 5 },
		});
		expect(s.connectionCheck).toEqual({
			enabled: false,
			intervalMs: 0,
			maxRetries: 5,
		});
		// maxRetries must be a positive integer.
		expect(() =>
			normalizeSettings({ connectionCheck: { maxRetries: 0 } }),
		).toThrow(/connectionCheck.maxRetries/);
	});

	it("parses manager sub-mode instruction files", () => {
		const s = normalizeSettings({
			manager: {
				firstMessageTemplate: "~/first.md",
				observer: { interlocutorInstructionFile: "~/i.md" },
				takeover: { instructionFile: "~/t.md" },
			},
		});
		expect(s.manager.firstMessageTemplate).toBe("~/first.md");
		expect(s.manager.observer.interlocutorInstructionFile).toBe("~/i.md");
		expect(s.manager.takeover.instructionFile).toBe("~/t.md");
	});

	it("defaults mentionWords to [llm, manager]; an explicit array (incl. []) is honoured", () => {
		expect(normalizeSettings({}).manager.mentionWords).toEqual([
			"llm",
			"manager",
		]);
		expect(
			normalizeSettings({ manager: { mentionWords: ["qwen", "bot"] } }).manager
				.mentionWords,
		).toEqual(["qwen", "bot"]);
		// Explicit empty array disables the feature.
		expect(
			normalizeSettings({ manager: { mentionWords: [] } }).manager.mentionWords,
		).toEqual([]);
	});

	it("defaults reopenAfterMs to 24h and accepts 0 to disable + an override file", () => {
		expect(normalizeSettings({}).manager.reopenAfterMs).toBe(86_400_000);
		const s = normalizeSettings({
			manager: { reopenAfterMs: 0, reopenTemplate: "~/reopen.md" },
		});
		expect(s.manager.reopenAfterMs).toBe(0);
		expect(s.manager.reopenTemplate).toBe("~/reopen.md");
	});

	it("defaults reviseThreshold to 2 and accepts an override (0 disables re-reads)", () => {
		expect(normalizeSettings({}).manager.reviseThreshold).toBe(2);
		expect(
			normalizeSettings({ manager: { reviseThreshold: 0 } }).manager
				.reviseThreshold,
		).toBe(0);
		expect(
			normalizeSettings({ manager: { reviseThreshold: 5 } }).manager
				.reviseThreshold,
		).toBe(5);
	});

	it("defaults debugFeed off and accepts an explicit toggle", () => {
		expect(normalizeSettings({}).manager.debugFeed).toBe(false);
		expect(
			normalizeSettings({ manager: { debugFeed: true } }).manager.debugFeed,
		).toBe(true);
	});

	it("defaults strictReplyGuard on and reads an optional ownerName", () => {
		expect(normalizeSettings({}).manager.strictReplyGuard).toBe(true);
		expect(normalizeSettings({}).manager.ownerName).toBeUndefined();
		const s = normalizeSettings({
			manager: { strictReplyGuard: false, ownerName: "Mansur" },
		});
		expect(s.manager.strictReplyGuard).toBe(false);
		expect(s.manager.ownerName).toBe("Mansur");
	});
});

describe("loadSettings", () => {
	it("returns defaults when the file is missing", async () => {
		const fs = new FakeFs();
		const { settings } = await loadSettings(fs, paths.settingsPath);
		expect(settings).toEqual(DEFAULT_SETTINGS);
	});

	it("reads and normalizes the on-disk file", async () => {
		const fs = new FakeFs();
		await fs.writeText(
			paths.settingsPath,
			JSON.stringify({ allowedUserId: 7, manager: { rememberMessages: 5 } }),
		);
		const { settings } = await loadSettings(fs, paths.settingsPath);
		expect(settings.allowedUserId).toBe(7);
		expect(settings.manager.rememberMessages).toBe(5);
	});
});
