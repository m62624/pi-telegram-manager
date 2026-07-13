import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
