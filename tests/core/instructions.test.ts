import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectInstructionFiles,
	expandHome,
	readInstructionFiles,
} from "../../src/core/instructions";
import {
	DEFAULT_SETTINGS,
	type TelegramSettings,
} from "../../src/settings/schema";
import { FakeFs } from "../helpers/fake-fs";

function settings(over: Partial<TelegramSettings> = {}): TelegramSettings {
	return { ...DEFAULT_SETTINGS, ...over };
}

describe("expandHome", () => {
	it("expands ~ and ~/", () => {
		expect(expandHome("~")).toBe(homedir());
		expect(expandHome("~/notes/x.md")).toBe(join(homedir(), "notes/x.md"));
		expect(expandHome("/abs/path.md")).toBe("/abs/path.md");
	});
});

describe("collectInstructionFiles", () => {
	it("combines global + mode-specific files", () => {
		const s = settings({
			instructionFiles: ["g.md"],
			connect: { instructionFiles: ["c.md"] },
			manager: { ...DEFAULT_SETTINGS.manager, instructionFiles: ["m.md"] },
		});
		expect(collectInstructionFiles(s, "connect")).toEqual(["g.md", "c.md"]);
		expect(collectInstructionFiles(s, "manager")).toEqual(["g.md", "m.md"]);
	});
});

describe("readInstructionFiles", () => {
	it("concatenates readable files and reports missing ones", async () => {
		const fs = new FakeFs();
		await fs.writeText("/a.md", "  Alpha  ");
		await fs.writeText("/b.md", "Beta");
		const res = await readInstructionFiles(fs, [
			"/a.md",
			"/missing.md",
			"/b.md",
		]);
		expect(res.text).toBe("Alpha\n\nBeta");
		expect(res.missing).toEqual(["/missing.md"]);
	});

	it("returns blank text when nothing is readable", async () => {
		const fs = new FakeFs();
		const res = await readInstructionFiles(fs, ["/nope.md"]);
		expect(res.text).toBe("");
		expect(res.missing).toEqual(["/nope.md"]);
	});
});
