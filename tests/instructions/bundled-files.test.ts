import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABOUT_TOPICS } from "../../src/core/about";
import { BUNDLED_INSTRUCTION_FILES } from "../../src/instructions/builtin";

/**
 * Every Markdown file this extension reads at RUNTIME must ship in the package.
 *
 * The two failure modes are different, and both are bad. A missing `about` page makes the
 * bot say "that page could not be read" when someone asks what it is. A missing
 * instruction file used to be worse: it yielded an empty string, and the manager started
 * anyway — with no rules about disclosure, no stance, nothing — and went on talking to
 * real people on the owner's behalf. That one is now fatal at mode start; this test is
 * what makes it impossible to ship in the first place.
 *
 * The lists are DERIVED from the code, not typed out here: a page renamed in the source
 * and forgotten in the package is exactly the drift this is for.
 */
const SRC = join(import.meta.dirname, "../../src");

function fileIsUsable(path: string): boolean {
	return existsSync(path) && statSync(path).size > 0;
}

/** The instruction files `builtin.ts` actually asks for, read out of its source. */
function requiredInstructionFiles(): string[] {
	const source = readFileSync(join(SRC, "instructions/builtin.ts"), "utf8");
	const names = source.match(/readBuiltin\(\s*[^,]+,\s*"([^"]+\.md)"/g) ?? [];
	return [
		...new Set(
			names.map((call) => (call.match(/"([^"]+\.md)"/) as string[])[1]),
		),
	];
}

describe("every bundled Markdown file the code reads", () => {
	it("exists for every about topic the tool offers", () => {
		// `current_settings` is generated from the live config; the rest are files.
		const pages = ABOUT_TOPICS.filter((topic) => topic !== "current_settings");
		expect(pages.length).toBeGreaterThan(0);
		for (const topic of pages) {
			const path = join(SRC, "about", `${topic}.md`);
			expect(fileIsUsable(path), `missing about page: ${topic}.md`).toBe(true);
		}
	});

	it("exists for every instruction file builtin.ts loads", () => {
		const required = requiredInstructionFiles();
		// A sanity check on the extraction itself: if the regex ever stops matching, the
		// test would pass vacuously and guard nothing.
		expect(required).toContain("manager-common.md");
		expect(required).toContain("connect.md");
		expect(required.length).toBeGreaterThanOrEqual(6);

		for (const name of required) {
			const path = join(SRC, "instructions", name);
			expect(fileIsUsable(path), `missing instruction file: ${name}`).toBe(
				true,
			);
		}
	});

	it("names every file the loader actually reads, so the preflight covers them all", () => {
		// `verifyBundledInstructions` walks BUNDLED_INSTRUCTION_FILES before a mode claims
		// anything. A file the loader reads but the list forgets would slip past that
		// check and blow up later, with the bridge already marked active.
		const declared = new Set<string>(BUNDLED_INSTRUCTION_FILES);
		for (const name of requiredInstructionFiles()) {
			expect(
				declared.has(name),
				`not in BUNDLED_INSTRUCTION_FILES: ${name}`,
			).toBe(true);
		}
	});

	it("is covered by the package's own file list", () => {
		// npm packs by the `files` globs. A Markdown file present in the repo but excluded
		// from the package is invisible until someone installs it FROM NPM — the one place
		// this cannot be caught after the fact.
		const pkg = JSON.parse(
			readFileSync(join(SRC, "../package.json"), "utf8"),
		) as { files?: string[] };
		expect(pkg.files, "package.json has no files list").toBeDefined();
		// Every runtime page lives under src/ and ends in .md, so this one glob is what
		// carries all of them into the tarball.
		expect(pkg.files).toContain("src/**/*.md");
	});
});
