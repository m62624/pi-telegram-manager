import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, TELEGRAM_BOT_COMMANDS } from "../../src/constants";
import { MIRROR_URL, REPO_URL } from "../../src/modes/connect/controller";
import { DEFAULT_SETTINGS } from "../../src/settings/schema";

/**
 * The `about` pages are what the model tells people about itself, so a page that
 * has drifted from the code is a bot stating something untrue with confidence. This
 * pins the two ways they drift: a new setting nobody documented, and a link that
 * moved.
 */
const ABOUT_DIR = join(import.meta.dirname, "../../src/about");

const page = (name: string): string =>
	readFileSync(join(ABOUT_DIR, name), "utf8");

/** Every leaf key of the settings schema, as `section.key` and as `key`. */
function settingsKeys(value: unknown, prefix = ""): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const keys: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const nested = settingsKeys(child, path);
		if (nested.length > 0) keys.push(...nested);
		else keys.push(path);
	}
	return keys;
}

describe("about pages match the code", () => {
	it("documents every command the bot actually publishes", () => {
		// Same failure as the settings page, one surface over: a command added to the menu
		// and not to the page means the owner asks "how do I free up context?" and the
		// model answers from imagination — the exact thing this tool exists to prevent.
		const doc = page("commands.md");
		const missing = TELEGRAM_BOT_COMMANDS.map(
			(entry) => `/${entry.command}`,
		).filter((command) => !doc.includes(command));
		expect(missing).toEqual([]);
	});

	it("does not promise a command the bot does not have", () => {
		const published = new Set(
			TELEGRAM_BOT_COMMANDS.map((entry) => `/${entry.command}`),
		);
		// The terminal's own Pi commands are named on the page on purpose, as the thing
		// the chat does NOT accept.
		const terminal = new Set(Object.values(COMMANDS).map((name) => `/${name}`));
		const claimed =
			page("commands.md")
				.match(/\/[a-z][a-z-]*/g)
				?.map((c) => c.toLowerCase()) ?? [];
		for (const command of claimed) {
			if (published.has(command) || terminal.has(command)) continue;
			// `settings.json` and the like are not commands.
			expect(command).toMatch(/^\/(settings|help)/);
		}
	});

	it("documents every setting the schema actually has", () => {
		// The bug this pins: the page was written by hand and silently missed 24 keys,
		// so the model simply did not know they existed.
		const doc = page("settings.md");
		const missing = settingsKeys(DEFAULT_SETTINGS)
			.map((path) => path.split(".").at(-1) as string)
			.filter((leaf) => !doc.includes(leaf));
		expect(missing).toEqual([]);
	});

	it("points at the same repository the rest of the code does", () => {
		const doc = page("project.md");
		expect(doc).toContain(REPO_URL);
		expect(doc).toContain(MIRROR_URL);
		expect(doc).toContain("https://www.npmjs.com/package/pi-telegram-manager");
	});

	it("does not claim the label is unremovable — only the disclosure is", () => {
		// `labeler` may be set to nothing (`applyLabeler` adds nothing when it is
		// empty), so promising "every message is labelled" would be a lie.
		const doc = page("privacy.md");
		expect(doc).toContain("cannot be switched off");
		expect(doc).toMatch(/they may set it to nothing/i);
	});

	it("does not promise a sandbox the owner can widen", () => {
		// `manager.allowedTools` exists; a flat "no shell, ever" would be false.
		const doc = page("modes.md");
		expect(doc).toContain("manager.allowedTools");
	});

	it("never tells the model it can read a document sent by a stranger", () => {
		const doc = page("settings.md");
		expect(doc).toMatch(/never read what is inside it/i);
	});
});

describe("the instructions point at the right tool", () => {
	/** Whitespace-normalized: these files are hard-wrapped, and a rule is not a line. */
	const instruction = (name: string): string =>
		readFileSync(
			join(import.meta.dirname, "../../src/instructions", name),
			"utf8",
		).replace(/\s+/g, " ");

	it("names our tool exactly, in both modes", () => {
		for (const file of ["connect.md", "manager-common.md"]) {
			expect(instruction(file)).toContain("telegram_bot_about");
		}
	});

	it("forbids substituting another extension's about tool", () => {
		// Live failure: the model reached for `planner_about` and described the wrong
		// software, because "about" is a name several extensions claim.
		for (const file of ["connect.md", "manager-common.md"]) {
			expect(instruction(file)).toContain("planner_about");
			expect(instruction(file)).toMatch(/never substitute it/i);
		}
	});

	it("forbids the specific lie the model tells when it guesses", () => {
		// It said: "a custom bridge, not a public product", "little information about
		// the extension". The project is public, MIT, on npm.
		for (const file of ["connect.md", "manager-common.md"]) {
			expect(instruction(file)).toMatch(/custom bridge, not a public product/i);
			expect(instruction(file)).toContain("pi-telegram-manager");
		}
	});

	it("carries the rule in BOTH instruction sets, so every mode has it", () => {
		// Personal loads connect.md; manager loads manager-common.md; mixed loads BOTH
		// (startConnectRuntime runs inside the mixed start too). A rule that lived in
		// only one of them would vanish in whichever polarity the other one owns.
		for (const file of ["connect.md", "manager-common.md"]) {
			const text = instruction(file);
			expect(text).toContain("telegram_bot_about");
			expect(text).toMatch(
				/never answer from memory|Never answer from memory|Do not answer from memory/,
			);
			// And the same non-negotiable: a chat cannot change a setting.
			expect(text).toMatch(/restart/i);
		}
	});
});
