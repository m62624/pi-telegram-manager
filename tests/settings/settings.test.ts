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
			manager: { continueWindowMs: 45_000, rememberMessages: 50 },
		});
		expect(s.manager.continueWindowMs).toBe(45_000);
		expect(s.manager.rememberMessages).toBe(50);
		// Untouched fields keep defaults.
		expect(s.manager.ownerReplyWindowMs).toBe(300_000);
		expect(s.manager.labeler).toBe("LLM agent 🤖:");
	});

	it("defaults the context char budget and honours overrides / 0 to disable", () => {
		expect(DEFAULT_SETTINGS.manager.maxCharsPerMessage).toBe(4000);
		expect(DEFAULT_SETTINGS.manager.maxContextChars).toBe(40000);
		const s = normalizeSettings({
			manager: { maxCharsPerMessage: 1000, maxContextChars: 0 },
		});
		expect(s.manager.maxCharsPerMessage).toBe(1000);
		expect(s.manager.maxContextChars).toBe(0);
		expect(() =>
			normalizeSettings({ manager: { maxContextChars: -5 } }),
		).toThrow(TypeError);
	});

	it("accepts an empty labeler (no prefix)", () => {
		expect(
			normalizeSettings({ manager: { labeler: "" } }).manager.labeler,
		).toBe("");
	});

	// A banner made of zero-width characters would pass for a banner everywhere it
	// is checked and show the interlocutor nothing. Turning the banner off is a
	// choice we allow; faking one is not — so a label with nothing visible in it is
	// simply no label.
	it("collapses a labeler that renders to nothing", () => {
		expect(
			normalizeSettings({ manager: { labeler: "\u200b\u200b" } }).manager
				.labeler,
		).toBe("");
		expect(
			normalizeSettings({ manager: { labeler: " \ufeff \u2060" } }).manager
				.labeler,
		).toBe("");
	});

	// ...but a name that merely CONTAINS one is a name: it is on the screen, it is
	// read, and it is not ours to rewrite.
	it("keeps invisible characters inside a real name", () => {
		expect(
			normalizeSettings({ manager: { labeler: "Pi\u200bAgent:" } }).manager
				.labeler,
		).toBe("Pi\u200bAgent:");
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

	it("defaults mixed.returnToTelegramMs to 8 minutes and honours overrides", () => {
		expect(normalizeSettings({}).mixed.returnToTelegramMs).toBe(480_000);
		expect(
			normalizeSettings({ mixed: { returnToTelegramMs: 90_000 } }).mixed
				.returnToTelegramMs,
		).toBe(90_000);
		// Must be a positive integer (0 disables nothing here — it would fire instantly).
		expect(() =>
			normalizeSettings({ mixed: { returnToTelegramMs: 0 } }),
		).toThrow(/mixed.returnToTelegramMs/);
	});

	it("parses the manager instruction files and the first-message template", () => {
		const s = normalizeSettings({
			manager: {
				firstMessageTemplate: "~/first.md",
				instructionFiles: ["~/policy.md"],
			},
		});
		expect(s.manager.firstMessageTemplate).toBe("~/first.md");
		expect(s.manager.instructionFiles).toEqual(["~/policy.md"]);
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

	it("defaults the manager log on and accepts an explicit toggle", () => {
		expect(normalizeSettings({}).manager.log).toBe(true);
		expect(normalizeSettings({ manager: { log: false } }).manager.log).toBe(
			false,
		);
	});

	it("still honours the former manager.debugFeed key", () => {
		expect(
			normalizeSettings({ manager: { debugFeed: false } }).manager.log,
		).toBe(false);
		// The new key wins when both are present.
		expect(
			normalizeSettings({ manager: { debugFeed: false, log: true } }).manager
				.log,
		).toBe(true);
	});

	it("defaults topics on, with personal/manager names", () => {
		expect(normalizeSettings({}).topics).toEqual({
			enabled: true,
			personalName: "personal",
			managerName: "manager",
		});
		expect(
			normalizeSettings({
				topics: { enabled: false, managerName: "secretary" },
			}).topics,
		).toEqual({
			enabled: false,
			personalName: "personal",
			managerName: "secretary",
		});
	});

	it("still honours the former topics.chatName / topics.logName keys", () => {
		expect(
			normalizeSettings({ topics: { chatName: "me", logName: "bot" } }).topics,
		).toEqual({ enabled: true, personalName: "me", managerName: "bot" });
	});

	it("caps images per turn at Telegram's album size by default", () => {
		// Pi imposes no limit of its own; the cap protects a small local context.
		expect(normalizeSettings({}).files.maxImagesPerTurn).toBe(10);
		expect(
			normalizeSettings({ files: { maxImagesPerTurn: 3 } }).files
				.maxImagesPerTurn,
		).toBe(3);
		// 0 disables the cap entirely.
		expect(
			normalizeSettings({ files: { maxImagesPerTurn: 0 } }).files
				.maxImagesPerTurn,
		).toBe(0);
	});

	it("defaults strictReplyGuard on and reads an optional ownerName", () => {
		expect(normalizeSettings({}).manager.strictReplyGuard).toBe(true);
		expect(normalizeSettings({}).manager.ownerName).toBeUndefined();
		const s = normalizeSettings({
			manager: { strictReplyGuard: false, ownerName: "Alex" },
		});
		expect(s.manager.strictReplyGuard).toBe(false);
		expect(s.manager.ownerName).toBe("Alex");
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

describe("assistant.toolOutputMaxBytes", () => {
	it("defaults to 25 MB — a truncated tool log is attached up to that size", () => {
		expect(DEFAULT_SETTINGS.assistant.toolOutputMaxBytes).toBe(26_214_400);
	});

	it("honours a smaller cap, and 0 to never attach", () => {
		// The point of the setting: someone on metered data caps it low, or off.
		expect(
			normalizeSettings({ assistant: { toolOutputMaxBytes: 1_048_576 } })
				.assistant.toolOutputMaxBytes,
		).toBe(1_048_576);
		expect(
			normalizeSettings({ assistant: { toolOutputMaxBytes: 0 } }).assistant
				.toolOutputMaxBytes,
		).toBe(0);
	});

	it("rejects a negative or fractional byte count", () => {
		expect(() =>
			normalizeSettings({ assistant: { toolOutputMaxBytes: -1 } }),
		).toThrow(/toolOutputMaxBytes/);
		expect(() =>
			normalizeSettings({ assistant: { toolOutputMaxBytes: 1.5 } }),
		).toThrow(/toolOutputMaxBytes/);
	});

	it("leaves the other assistant settings alone", () => {
		const s = normalizeSettings({ assistant: { toolOutputMaxBytes: 10 } });
		expect(s.assistant.draftPreviews).toBe(true);
		expect(s.assistant.toolActivity).toBe(true);
		expect(s.assistant.rendering).toBe("rich");
	});
});
