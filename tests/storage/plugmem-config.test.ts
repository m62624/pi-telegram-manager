import { describe, expect, it } from "vitest";
import {
	buildPlugmemConfig,
	embedderActive,
	validateEmbedder,
} from "../../src/storage/plugmem-config";

/**
 * The generated `config.toml`, and the validation that goes with it.
 *
 * The validation is a deliberate copy of plugmem's own (`EmbedderCfg::build`), and
 * these tests are what keep the copy honest. Its whole value is moving the error in
 * time: plugmem rejects a bad `[embedder]` when it opens a database, which would be
 * somewhere in the middle of the first turn taken for a stranger.
 */

describe("buildPlugmemConfig", () => {
	it("writes dim 0 and no provider when there is no embedder", () => {
		const toml = buildPlugmemConfig({ kind: "none", dim: 0 });
		expect(toml).toContain("dim = 0");
		expect(toml).toContain('kind = "none"');
		// Nothing else: an endpoint written under `kind = "none"` reads like a setting
		// that is doing something.
		expect(toml).not.toContain("url");
		expect(toml).not.toContain("model");
	});

	it("passes an embedder through verbatim", () => {
		const toml = buildPlugmemConfig({
			kind: "ollama",
			url: "http://localhost:11434/v1",
			model: "nomic-embed-text",
			apiKeyEnv: "OPENAI_API_KEY",
			dim: 768,
		});
		expect(toml).toContain("dim = 768");
		expect(toml).toContain('kind = "ollama"');
		expect(toml).toContain('url = "http://localhost:11434/v1"');
		expect(toml).toContain('model = "nomic-embed-text"');
		expect(toml).toContain('api_key_env = "OPENAI_API_KEY"');
	});

	it("escapes a value rather than trusting it", () => {
		// The failure of not escaping is a config file plugmem cannot parse, reported to
		// the owner as a memory that will not open — a long way from the quote mark that
		// caused it.
		const toml = buildPlugmemConfig({
			kind: "openai",
			url: 'http://host/"odd"',
			model: "a\\b",
			dim: 1,
		});
		expect(toml).toContain('url = "http://host/\\"odd\\""');
		expect(toml).toContain('model = "a\\\\b"');
	});

	it("omits the key env when there is none to name", () => {
		const toml = buildPlugmemConfig({
			kind: "lmstudio",
			url: "http://localhost:1234/v1",
			model: "e5",
			dim: 384,
		});
		expect(toml).not.toContain("api_key_env");
	});
});

describe("validateEmbedder", () => {
	it("accepts the default: no embedder, no vectors", () => {
		expect(() => validateEmbedder({ kind: "none", dim: 0 })).not.toThrow();
		expect(embedderActive({ kind: "none", dim: 0 })).toBe(false);
	});

	it("refuses a width on an embedder that is switched off", () => {
		// Not pedantry: `dim` is written into every database at creation, so a stray
		// non-zero here would silently create vector-shaped databases with nothing to
		// fill them — and then refuse to open them once the embedder was really turned on.
		expect(() => validateEmbedder({ kind: "none", dim: 768 })).toThrow(
			/dim must be 0/,
		);
	});

	it("requires a url, a model and a width once one is switched on", () => {
		expect(() => validateEmbedder({ kind: "ollama", dim: 768 })).toThrow(
			/url is required/,
		);
		expect(() =>
			validateEmbedder({ kind: "ollama", url: "http://x/v1", dim: 768 }),
		).toThrow(/model is required/);
		expect(() =>
			validateEmbedder({
				kind: "ollama",
				url: "http://x/v1",
				model: "e5",
				dim: 0,
			}),
		).toThrow(/dim must be greater than 0/);
	});

	it("names the offending key, the way every other setting check does", () => {
		expect(() =>
			validateEmbedder({ kind: "vllm", dim: 1 }, "memory.embedder"),
		).toThrow(/memory\.embedder\.url/);
	});
});
