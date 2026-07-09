import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

async function walkTs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkTs(full)));
		} else if (entry.name.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

describe("architecture invariants", () => {
	it("only src/pi/* imports the Pi SDK (@earendil-works/*)", async () => {
		const files = await walkTs(srcDir);
		const offenders: string[] = [];
		for (const file of files) {
			const rel = file.slice(srcDir.length + 1);
			if (rel.startsWith(`pi${"/"}`)) continue;
			const text = await readFile(file, "utf8");
			// Match real import/export-from statements, not prose in comments.
			if (/\bfrom\s+["']@earendil-works\//.test(text)) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
