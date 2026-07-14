import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type TelegramSettings,
} from "../../src/settings/schema";

/**
 * SETTINGS.md carries the whole `settings.json` written out, so nobody has to guess how
 * deep a key sits. A documented file that has drifted from the schema is worse than no
 * example at all: it is a config someone will paste, and it will be wrong.
 *
 * So the example is checked against the code, both ways — every real key is in it, and
 * every key in it is real.
 */
const EXAMPLE_START = "<!-- settings-example:start -->";
const EXAMPLE_END = "<!-- settings-example:end -->";

/** The keys with no default: shown with example values, so their VALUES are not pinned. */
const NO_DEFAULT = new Set([
	"botToken",
	"allowedUserId",
	"timezone",
	"assistant.toolOutputDir",
	"manager.ownerName",
]);

function exampleJson(): Record<string, unknown> {
	const doc = readFileSync(
		join(import.meta.dirname, "../../SETTINGS.md"),
		"utf8",
	);
	const start = doc.indexOf(EXAMPLE_START);
	const end = doc.indexOf(EXAMPLE_END);
	expect(
		start,
		"the example block is missing from SETTINGS.md",
	).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	const block = doc.slice(start, end);
	const json = block.slice(
		block.indexOf("```json") + "```json".length,
		block.lastIndexOf("```"),
	);
	return JSON.parse(json) as Record<string, unknown>;
}

/** Every leaf path of an object: `manager.media.images`, `assistant.rendering`, … */
function leafPaths(value: unknown, prefix = ""): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return prefix ? [prefix] : [];
	}
	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const nested = leafPaths(child, path);
		paths.push(...(nested.length > 0 ? nested : [path]));
	}
	return paths;
}

function valueAt(value: unknown, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>(
			(node, key) => (node as Record<string, unknown> | undefined)?.[key],
			value,
		);
}

describe("the settings example in SETTINGS.md", () => {
	it("shows every setting the schema actually has", () => {
		// The drift that matters: a setting is added, nobody puts it in the example, and
		// the one place people copy from silently stops mentioning it.
		const example = exampleJson();
		const documented = new Set(leafPaths(example));
		const missing = leafPaths(DEFAULT_SETTINGS).filter(
			(path) => !documented.has(path),
		);
		expect(missing).toEqual([]);
	});

	it("invents nothing the schema does not have", () => {
		const example = exampleJson();
		const real = new Set([...leafPaths(DEFAULT_SETTINGS), ...NO_DEFAULT]);
		const invented = leafPaths(example).filter((path) => !real.has(path));
		expect(invented).toEqual([]);
	});

	it("shows the REAL default of every key that has one", () => {
		// An example that says `"toolActivity": false` while the code ships `true` teaches
		// the reader something false about their own bot.
		const example = exampleJson();
		for (const path of leafPaths(DEFAULT_SETTINGS)) {
			if (NO_DEFAULT.has(path)) continue;
			expect(valueAt(example, path), `default of ${path}`).toEqual(
				valueAt(DEFAULT_SETTINGS, path),
			);
		}
	});

	it("is a file the extension actually accepts", () => {
		// It is a config people paste. It must parse — and it must not warn about a key
		// the parser does not know.
		const example = exampleJson();
		expect(() =>
			normalizeSettings(example as Partial<TelegramSettings>),
		).not.toThrow();
		const settings = normalizeSettings(example as Partial<TelegramSettings>);
		expect(settings.assistant.thinkingPlaceholder).toBe(false);
		expect(settings.manager.labeler).toBe(DEFAULT_SETTINGS.manager.labeler);
	});
});
