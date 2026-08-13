import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensurePlugmemConfig,
	resolveConfigPath,
} from "../../src/storage/config-file";
import { FakeFs } from "../helpers/fake-fs";

/**
 * Who owns plugmem's `config.toml`, and what happens when it is not where the owner
 * said it was.
 *
 * The rules are asymmetric on purpose, and the asymmetry is what these tests are
 * for: a missing file at the DEFAULT location is how somebody asks for the defaults
 * back, while a missing file at a location they NAMED is almost always a typo — and
 * one that would otherwise be discovered by editing a file nothing reads.
 */

const EXTENSION_DIR = "/agent/extensions/pi-telegram-manager";
const DEFAULT_PATH = join(EXTENSION_DIR, "memory", "config.toml");

function base(fs: FakeFs, configured?: string) {
	return {
		fs,
		defaultPath: DEFAULT_PATH,
		extensionDir: EXTENSION_DIR,
		...(configured === undefined ? {} : { configured }),
	};
}

describe("resolveConfigPath", () => {
	it("falls back to the memory directory inside the extension", () => {
		expect(resolveConfigPath(base(new FakeFs()))).toBe(DEFAULT_PATH);
	});

	it("treats blank as unset, because a blank path is not a path", () => {
		expect(resolveConfigPath(base(new FakeFs(), "   "))).toBe(DEFAULT_PATH);
	});

	it("takes an absolute path as given", () => {
		expect(resolveConfigPath(base(new FakeFs(), "/etc/plugmem.toml"))).toBe(
			"/etc/plugmem.toml",
		);
	});

	it("reads a relative path from the extension, not from where Pi started", () => {
		expect(resolveConfigPath(base(new FakeFs(), "custom/plug.toml"))).toBe(
			join(EXTENSION_DIR, "custom/plug.toml"),
		);
	});

	it("expands a leading ~ against the home it was handed", () => {
		expect(
			resolveConfigPath({
				...base(new FakeFs(), "~/plugmem.toml"),
				home: "/home/owner",
			}),
		).toBe("/home/owner/plugmem.toml");
	});
});

describe("ensurePlugmemConfig", () => {
	it("writes a default file when there is none, and says nothing", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig(base(fs));
		expect(result.created).toBe(true);
		expect(result.notice).toBe("");
		expect(await fs.readText(DEFAULT_PATH)).toContain("[embedder]");
	});

	it("asks for degrade, so an outage costs the vector and not the answer", async () => {
		// In a mode that answers strangers on the owner's behalf, a failed embedding
		// call would otherwise mean refusing somebody who is waiting.
		const fs = new FakeFs();
		await ensurePlugmemConfig(base(fs));
		expect(await fs.readText(DEFAULT_PATH)).toContain('on_error = "degrade"');
	});

	it("never touches a file that is already there", async () => {
		const fs = new FakeFs();
		await fs.writeTextAtomic(DEFAULT_PATH, "[engine]\ndim = 7\n");
		const result = await ensurePlugmemConfig(base(fs));
		expect(result.created).toBe(false);
		expect(await fs.readText(DEFAULT_PATH)).toBe("[engine]\ndim = 7\n");
	});

	it("puts the defaults back when the file was deleted", async () => {
		const fs = new FakeFs();
		await ensurePlugmemConfig(base(fs));
		await fs.removeFile(DEFAULT_PATH);
		expect((await ensurePlugmemConfig(base(fs))).created).toBe(true);
	});

	it("says so out loud when a NAMED path had no file", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig(base(fs, "/etc/plugmem.toml"));
		expect(result.notice).toContain("/etc/plugmem.toml");
		// Written where they pointed, so the next edit lands in the right file.
		expect(await fs.readText("/etc/plugmem.toml")).toContain("[embedder]");
	});

	it("carries an older installation's embedder into the file", async () => {
		const fs = new FakeFs();
		const result = await ensurePlugmemConfig({
			...base(fs),
			legacy: {
				enabled: true,
				url: "http://localhost:11434/v1/embeddings",
				model: "nomic-embed-text",
				dim: 768,
			},
		});
		const written = await fs.readText(DEFAULT_PATH);
		expect(written).toContain("enabled = true");
		expect(written).toContain('model = "nomic-embed-text"');
		expect(written).toContain("dim = 768");
		// The policy the old settings had no way to state.
		expect(written).toContain('on_error = "degrade"');
		expect(result.notice).toMatch(/moved to/i);
	});

	it("does not migrate over a file that already exists", async () => {
		// The file wins — it is the one plugmem reads — and the settings that no
		// longer do anything are named rather than left to be edited in vain.
		const fs = new FakeFs();
		await fs.writeTextAtomic(DEFAULT_PATH, "[engine]\ndim = 7\n");
		const result = await ensurePlugmemConfig({
			...base(fs),
			legacy: {
				enabled: true,
				url: "http://x/v1/embeddings",
				model: "m",
				dim: 8,
			},
		});
		expect(await fs.readText(DEFAULT_PATH)).toBe("[engine]\ndim = 7\n");
		expect(result.notice).toMatch(/memory\.embedder/);
		expect(result.notice).toContain(DEFAULT_PATH);
	});

	it("refuses to migrate an embedder plugmem would refuse", async () => {
		// Those values came out of a file the owner wrote, so the complaint names
		// their key rather than arriving later as an opinion about TOML.
		const fs = new FakeFs();
		await expect(
			ensurePlugmemConfig({
				...base(fs),
				legacy: { enabled: true, model: "m", dim: 8 },
			}),
		).rejects.toThrow(/memory\.embedder\.url/);
		expect(await fs.exists(DEFAULT_PATH)).toBe(false);
	});
});
