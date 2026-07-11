/**
 * One-off migrations for the contact-fact store.
 *
 * The applied schema version is kept in a tiny marker file; when it lags behind
 * {@link MEMORY_SCHEMA_VERSION} the pending migrations run once, then the marker
 * is bumped. Idempotent: a second start with an up-to-date marker is a no-op.
 */
import type { ContactStore } from "./contact-store";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/**
 * Bump when the contact-fact schema changes and stored facts must be discarded.
 * v2: facts gained `subject`/`kind` and a who-is-who firewall — flat pre-v2 facts
 * were captured without subject attribution and are mis-attributed under the new
 * rules, so they are wiped rather than migrated in place.
 */
export const MEMORY_SCHEMA_VERSION = 2;

interface MemoryVersionMarker {
	version: number;
}

/**
 * Apply pending memory migrations. Returns true when a migration actually ran
 * (facts were wiped), false when the store was already current.
 */
export async function migrateMemory(
	fs: TelegramFs,
	versionPath: string,
	contactStore: ContactStore,
): Promise<boolean> {
	const marker = await readJsonIfExists<MemoryVersionMarker>(fs, versionPath);
	const applied = marker?.version ?? 0;
	if (applied >= MEMORY_SCHEMA_VERSION) return false;
	await contactStore.clearAllFacts();
	await writeJson(fs, versionPath, { version: MEMORY_SCHEMA_VERSION });
	return true;
}
