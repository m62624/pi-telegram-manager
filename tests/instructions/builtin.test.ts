import { describe, expect, it } from "vitest";
import {
	loadConnectInstructions,
	loadManagerInstructions,
	SYSTEM_INSTRUCTIONS_HEADER,
} from "../../src/instructions/builtin";
import type { TelegramFs } from "../../src/storage/fs";

/**
 * A read-only fake fs that serves bundled instruction files by basename, so the
 * loader's assembly logic is tested without touching real disk layout.
 */
function stubFs(files: Record<string, string>): TelegramFs {
	return {
		async readText(path: string) {
			for (const [name, content] of Object.entries(files)) {
				if (path.endsWith(name)) return content;
			}
			throw new Error(`ENOENT: ${path}`);
		},
	} as unknown as TelegramFs;
}

const BUNDLED = {
	"manager-common.md": "COMMON RULES",
	"manager.md": "MANAGER BODY",
	"manager-first-message.md": "DEFAULT FIRST",
	"manager-reopen.md": "DEFAULT REOPEN",
	"connect.md": "CONNECT BODY",
};

describe("loadManagerInstructions", () => {
	it("assembles the common rules and the manager stance", async () => {
		const result = await loadManagerInstructions({ fs: stubFs(BUNDLED) });
		expect(result.base).toContain("COMMON RULES");
		expect(result.base).toContain("MANAGER BODY");
		expect(result.firstMessage).toBe("DEFAULT FIRST");
		expect(result.reopen).toBe("DEFAULT REOPEN");
	});

	it("layers a user override on top of the bundled rules", async () => {
		const result = await loadManagerInstructions({
			fs: stubFs(BUNDLED),
			overrideText: "MY CUSTOM POLICY",
			firstMessageOverride: "MY FIRST TEMPLATE",
			reopenOverride: "MY REOPEN TEMPLATE",
		});
		expect(result.base).toContain("COMMON RULES");
		expect(result.base).toContain("MY CUSTOM POLICY");
		expect(result.firstMessage).toBe("MY FIRST TEMPLATE");
		expect(result.reopen).toBe("MY REOPEN TEMPLATE");
	});

	it("surfaces the configured wake-words to the model", async () => {
		const result = await loadManagerInstructions({
			fs: stubFs(BUNDLED),
			labeler: "Assistant:",
			mentionWords: ["llm", "qwen"],
		});
		expect(result.base).toContain('"llm", "qwen"');
		expect(result.base).toContain("wake-word");
	});

	it("survives missing bundled files without throwing", async () => {
		const result = await loadManagerInstructions({
			fs: stubFs({}),
			subMode: "observer",
		});
		expect(result.base).toBe("");
		expect(result.firstMessage).toBe("");
	});
});

describe("loadConnectInstructions", () => {
	it("returns the bundled connect body, with any override appended", async () => {
		expect(await loadConnectInstructions({ fs: stubFs(BUNDLED) })).toBe(
			"CONNECT BODY",
		);
		const merged = await loadConnectInstructions({
			fs: stubFs(BUNDLED),
			overrideText: "EXTRA",
		});
		expect(merged).toContain("CONNECT BODY");
		expect(merged).toContain("EXTRA");
	});
});

it("exposes a stable system-instructions header", () => {
	expect(SYSTEM_INSTRUCTIONS_HEADER).toBe("[SYSTEM_INSTRUCTIONS]");
});
