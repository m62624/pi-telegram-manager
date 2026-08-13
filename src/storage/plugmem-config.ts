/**
 * What goes into a `config.toml` this extension writes.
 *
 * It writes one exactly twice: the first time a memory workspace exists at all, and
 * the first time an older installation's `memory.embedder` settings need a home.
 * After that the file belongs to the owner and plugmem is the only thing that reads
 * it — see `storage/config-file.ts` for who owns what, and why mirroring plugmem's
 * keys into `settings.json` was worth stopping.
 *
 * The validation below is a DELIBERATE duplicate of plugmem's own
 * (`plugmem-host/src/settings.rs`, `EmbedderCfg::build`), and it survives for the
 * migration alone: those values came out of a file the owner typed, so the complaint
 * should name `memory.embedder.url` rather than arrive later as plugmem's opinion of
 * a TOML file nobody has seen yet. Anything typed into `config.toml` afterwards is
 * plugmem's to judge, and it does.
 *
 * Pure: strings in, a string out. Writing them is `config-file.ts`'s job.
 */

export interface EmbedderSettings {
	/** Keep the settings but create and call no embedder when false. */
	enabled: boolean;
	/** Complete OpenAI-compatible embeddings endpoint; no path is appended. */
	url?: string;
	/** Embedding model name. */
	model?: string;
	/** Name of the environment variable holding the bearer token, if one is needed. */
	apiKeyEnv?: string;
	/**
	 * Embedding width. `0` — the default — means no vector storage.
	 *
	 * It is written INTO the database, and plugmem refuses to open a database whose
	 * stored width disagrees with the configured one. So this is the one memory
	 * setting that cannot be changed in place on a memory that already has facts in
	 * it; see the note in SETTINGS.md.
	 */
	dim: number;
	/**
	 * The stable identity a database's stored vectors are tagged with, so plugmem
	 * knows whether a later `model` still describes them. Unset — the default —
	 * falls back to `model` itself, which is right until two different model names
	 * are known to produce interchangeable vectors (a rename, a proxy alias): only
	 * then does declaring the same `spaceId` for both let plugmem treat them as one
	 * space and skip a reembed neither needs. Changing `spaceId` on an embedder that
	 * already has vectors is exactly what a vector-space mismatch is — see the note
	 * in SETTINGS.md.
	 */
	spaceId?: string;
}

/**
 * The file a fresh installation gets.
 *
 * Deliberately short. plugmem's own `config.example.toml` lists every key it takes
 * with its default, and copying that here would freeze today's defaults into every
 * owner's file; what belongs here is the handful of lines somebody has to change to
 * get meaning-based recall working, and a pointer to the rest.
 */
export const DEFAULT_PLUGMEM_CONFIG = `# plugmem's configuration for this bot's per-contact memories.
#
# This file is yours. pi-telegram-manager writes it once, when it is not there, and
# never edits it afterwards - so delete it to get these defaults back.
#
# Only the keys below are set; everything else stays at plugmem's own tuned
# defaults. The full list, with every default and what it is for, is in plugmem's
# config.example.toml and SETTINGS.md.
#
# [database] and [workspace] are the exception: they do nothing here. The workspace
# directory is this file's own directory, passed explicitly, and one database per
# contact is resolved by name inside it. Everything else applies to all of them.

[engine]
# Embedding width. 0 stores no vectors at all. With an embedder on it has to match
# what the model returns, and it is written into each database at creation -
# changing it later means a rebuild (/telegram-memory-reembed).
dim = 0

[embedder]
# Off by default, so a bot on a machine with no embedding service still works:
# keyword, entity-graph and time recall need no model and no network. What an
# embedder adds is matching by MEANING - "when should I reach them?" finding a fact
# that says "prefers to be called in the evening".
enabled = false
# url = "http://localhost:11434/v1/embeddings"
# model = "bge-m3"
# An unreachable provider stores and answers WITHOUT a vector rather than failing
# the call, and suspends itself until it can be reached again. Facts written
# meanwhile get their vectors from /telegram-memory-reembed. "fail" refuses instead,
# which in a mode that answers strangers means refusing them.
on_error = "degrade"
# The NAME of an environment variable holding the bearer token - never a token.
# api_key_env = "OPENAI_API_KEY"
`;

/**
 * Whether these embedder settings were ever touched.
 *
 * The question a migration has to answer is "does this owner have an embedder worth
 * carrying over", and settings that are byte-for-byte the defaults are the ones
 * nobody chose. They carry no information, so they are not carried.
 */
export function embedderWasConfigured(embedder: EmbedderSettings): boolean {
	return (
		embedder.enabled ||
		embedder.dim !== 0 ||
		embedder.url !== undefined ||
		embedder.model !== undefined ||
		embedder.apiKeyEnv !== undefined ||
		embedder.spaceId !== undefined
	);
}

/** plugmem's own ceiling on a persisted embedding-space identity (`MAX_VECTOR_SPACE_ID_BYTES`). */
export const MAX_SPACE_ID_BYTES = 256;

/** Whether the configured embedder is enabled. */
export function embedderActive(embedder: EmbedderSettings): boolean {
	return embedder.enabled;
}

/**
 * Reject an embedder plugmem would reject, at settings-load time.
 *
 * Throws {@link TypeError} with the path of the offending key, the way every other
 * check in `settings/schema.ts` does.
 */
export function validateEmbedder(
	embedder: EmbedderSettings,
	path = "memory.embedder",
): void {
	// Disabled settings are deliberately retained, including their dimension. That
	// lets an owner turn the same provider back on without changing an existing
	// database's fixed vector width.
	if (!embedderActive(embedder)) return;
	if (!embedder.url?.trim()) {
		throw new TypeError(`${path}.url is required when ${path}.enabled is true`);
	}
	if (!embedder.model?.trim()) {
		throw new TypeError(
			`${path}.model is required when ${path}.enabled is true`,
		);
	}
	if (embedder.dim <= 0) {
		throw new TypeError(
			`${path}.dim must be greater than 0 when ${path}.enabled is true`,
		);
	}
	if (embedder.spaceId !== undefined) {
		if (!embedder.spaceId.trim()) {
			throw new TypeError(`${path}.spaceId must not be empty`);
		}
		const bytes = new TextEncoder().encode(embedder.spaceId).length;
		if (bytes > MAX_SPACE_ID_BYTES) {
			throw new TypeError(
				`${path}.spaceId must be at most ${MAX_SPACE_ID_BYTES} bytes, got ${bytes}`,
			);
		}
	}
}

/**
 * A TOML basic string.
 *
 * These values are a URL, a model name and an environment variable name — none of
 * which should contain a quote or a backslash, and all of which come from a file the
 * owner edits by hand. Escaped rather than trusted, because the failure mode of not
 * escaping is a config file plugmem cannot parse, reported as a memory that will not
 * open.
 */
function tomlString(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

/**
 * The same embedder, said in TOML — the one-time move out of `settings.json`.
 *
 * Only two sections, because those are the only things the old settings could say:
 * `[engine].dim`, and `[embedder]`. From here on the file is edited by hand, and
 * everything else plugmem takes is available in it.
 *
 * `on_error` is the one thing added rather than translated: `settings.json` had no
 * such key, the old behaviour was to fail, and in a mode that answers strangers on
 * the owner's behalf an outage should cost the vector rather than the answer. It is
 * written explicitly so the file says what it does.
 */
export function buildPlugmemConfig(embedder: EmbedderSettings): string {
	const lines = [
		"# Moved here from settings.json (memory.embedder.*) by pi-telegram-manager.",
		"#",
		"# This file is yours now: nothing overwrites it, and plugmem is the only thing",
		"# that reads it. Every other key it takes - recall weights, the maintenance",
		"# triggers - is documented in plugmem's config.example.toml.",
		"",
		"[engine]",
		`dim = ${embedder.dim}`,
		"",
		"[embedder]",
		`enabled = ${embedder.enabled}`,
	];
	if (embedder.url !== undefined) {
		lines.push(`url = ${tomlString(embedder.url)}`);
	}
	if (embedder.model !== undefined) {
		lines.push(`model = ${tomlString(embedder.model)}`);
	}
	if (embedder.spaceId !== undefined) {
		lines.push(`space_id = ${tomlString(embedder.spaceId)}`);
	}
	if (embedder.apiKeyEnv?.trim()) {
		lines.push(`api_key_env = ${tomlString(embedder.apiKeyEnv.trim())}`);
	}
	lines.push(
		"# An unreachable provider stores and answers without a vector instead of",
		'# failing the call, and retries by itself. Set to "fail" to be refused.',
		'on_error = "degrade"',
	);
	return `${lines.join("\n")}\n`;
}
