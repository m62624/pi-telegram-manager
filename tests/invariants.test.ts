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

	// The session's busy flag is what every hand-off asks before prompting, and it may
	// only be lowered where the session can really take a prompt. `agent_end` is not
	// that place: Pi awaits the handler from inside the run, so the run is still on the
	// stack, `isIdle()` is false and `waitForIdle()` cannot resolve until the handler
	// returns. Lowering it there told the queue pump and the manager they could prompt,
	// and each then waited out the full idle deadline on a promise it was itself
	// blocking — two minutes of "Working…" with no inference running. `agent_settled`
	// is emitted after the run flag is cleared, which is the first honest moment.
	it("lowers the session-busy flag on agent_settled, never inside agent_end", async () => {
		const text = await readFile(join(srcDir, "index.ts"), "utf8");
		const lowered = [...text.matchAll(/^\t*busy = false;$/gm)];
		expect(lowered).toHaveLength(1);

		const settledAt = text.indexOf('pi.on("agent_settled"');
		expect(settledAt).toBeGreaterThan(-1);
		// The next handler registered after it bounds the settled handler's body.
		const nextHandlerAt = text.indexOf("pi.on(", settledAt + 1);
		const at = lowered[0].index;
		expect(at).toBeGreaterThan(settledAt);
		expect(at).toBeLessThan(nextHandlerAt);
	});
});
