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
	it("writes an explicit disabled embedder by default", () => {
		const toml = buildPlugmemConfig({ enabled: false, dim: 0 });
		expect(toml).toContain("dim = 0");
		expect(toml).toContain("enabled = false");
		expect(toml).not.toContain("kind");
		expect(toml).not.toContain("url");
		expect(toml).not.toContain("model");
	});

	it("passes the full endpoint and model through verbatim", () => {
		const toml = buildPlugmemConfig({
			enabled: true,
			url: "http://localhost:11434/v1/embeddings",
			model: "nomic-embed-text",
			apiKeyEnv: "OPENAI_API_KEY",
			dim: 768,
		});
		expect(toml).toContain("dim = 768");
		expect(toml).toContain("enabled = true");
		expect(toml).toContain('url = "http://localhost:11434/v1/embeddings"');
		expect(toml).toContain('model = "nomic-embed-text"');
		expect(toml).toContain('api_key_env = "OPENAI_API_KEY"');
	});

	it("keeps provider settings while disabled", () => {
		const toml = buildPlugmemConfig({
			enabled: false,
			url: "https://api.openai.com/v1/embeddings",
			model: "text-embedding-3-small",
			dim: 1536,
		});
		expect(toml).toContain("dim = 1536");
		expect(toml).toContain("enabled = false");
		expect(toml).toContain('url = "https://api.openai.com/v1/embeddings"');
		expect(toml).toContain('model = "text-embedding-3-small"');
	});

	it("escapes a value rather than trusting it", () => {
		// The failure of not escaping is a config file plugmem cannot parse, reported to
		// the owner as a memory that will not open — a long way from the quote mark that
		// caused it.
		const toml = buildPlugmemConfig({
			enabled: true,
			url: 'http://host/v1/embeddings/"odd"',
			model: "a\\b",
			dim: 1,
		});
		expect(toml).toContain('url = "http://host/v1/embeddings/\\"odd\\""');
		expect(toml).toContain('model = "a\\\\b"');
	});

	it("omits the key env when there is none to name", () => {
		const toml = buildPlugmemConfig({
			enabled: true,
			url: "http://localhost:1234/v1/embeddings",
			model: "e5",
			dim: 384,
		});
		expect(toml).not.toContain("api_key_env");
	});
});

describe("validateEmbedder", () => {
	it("accepts the default: no embedder, no vectors", () => {
		expect(() => validateEmbedder({ enabled: false, dim: 0 })).not.toThrow();
		expect(embedderActive({ enabled: false, dim: 0 })).toBe(false);
	});

	it("allows disabled settings to retain their vector width", () => {
		// The width is fixed in the database. Keeping it while disabled lets the owner
		// switch the same endpoint back on without making existing memories unopenable.
		expect(() =>
			validateEmbedder({
				enabled: false,
				url: "http://localhost:11434/v1/embeddings",
				model: "nomic-embed-text",
				dim: 768,
			}),
		).not.toThrow();
	});

	it("requires a url, a model and a width once one is switched on", () => {
		expect(() => validateEmbedder({ enabled: true, dim: 768 })).toThrow(
			/url is required/,
		);
		expect(() =>
			validateEmbedder({
				enabled: true,
				url: "http://x/v1/embeddings",
				dim: 768,
			}),
		).toThrow(/model is required/);
		expect(() =>
			validateEmbedder({
				enabled: true,
				url: "http://x/v1/embeddings",
				model: "e5",
				dim: 0,
			}),
		).toThrow(/dim must be greater than 0/);
	});

	it("names the offending key, the way every other setting check does", () => {
		expect(() =>
			validateEmbedder({ enabled: true, dim: 1 }, "memory.embedder"),
		).toThrow(/memory\.embedder\.url/);
	});
});
