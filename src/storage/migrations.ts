/**
 * How this extension's files get from the layout an older version wrote to the one this
 * version reads.
 *
 * The project grew a file at a time, and every rename left a reader behind that quietly
 * understood the old shape as well as the new one. That works, and it is a trap: the data
 * is never actually migrated, so the reader can never be deleted, and the next rename
 * adds a third shape to it. Six months of that and nobody can say what is on disk.
 *
 * So the compatibility lives HERE, once, and runs once. The readers understand exactly
 * one shape each — the current one — and if they meet anything else, that is a bug, not a
 * feature.
 *
 * The rules this obeys, because a migration that breaks somebody's data is worse than the
 * mess it cleans up:
 *
 *  - **A missing file is not an error.** It means that part of the layout was never
 *    written — a clean install, or a mode the owner never used. The step does nothing and
 *    the run carries on. Nothing here may assume it is looking at a complete install.
 *  - **Every step is idempotent.** It reads what is there, writes what should be there,
 *    and removes the old file only once the new one is safely written. Interrupted
 *    halfway (a crash, a kill), the next start finds the sources still in place and does
 *    it again.
 *  - **Write the new file BEFORE deleting the old ones.** Every write is atomic
 *    (`writeTextAtomic`: temp file, then rename), so the window in which both exist is
 *    survivable and the window in which neither exists does not occur.
 *  - **Never widen the blast radius.** A step that cannot do its job leaves its sources
 *    alone and reports itself; it does not half-migrate.
 *
 * The version marker is the only thing that decides whether any of this runs, and it is
 * written last.
 */
import { type ChatStateRecord, DEFAULT_MAX_SENT_PER_CHAT } from "./chat-state";
import type { DmState, ModePin } from "./dm-state";
import { withFileWriteLock } from "./file-lock";
import { safeReaddir, type TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";
import type { MemoryWorkspace } from "./memory";
import type { TelegramPaths } from "./paths";

/**
 * The layout this version of the extension reads.
 *
 * 1 — the first unified layout: three per-chat files folded into `chat-state.json`, the
 *     owner's two DM files into `dm-state.json`, the renamed settings keys rewritten in
 *     place, and the contact-fact schema marker absorbed into this one.
 *
 * Bump it, add a step, and leave the old steps alone: someone out there is on version 0.
 */
export const LAYOUT_VERSION = 1;

/**
 * The contact-fact schema. A stored fact captured under older rules is not migrated but
 * DISCARDED — a fact is a claim about a person, and a claim we can no longer vouch for is
 * worse than no claim.
 *
 * v2: facts gained `subject`/`kind` and a who-is-who firewall; flat pre-v2 facts were
 *     captured without subject attribution and are mis-attributed under the new rules.
 * v3: a stored message used to carry the text it REPLIED to inside its own line, so the
 *     evidence check confirmed facts about a contact out of words the owner or the bot
 *     had written. Every v2 fact was verified against that polluted evidence.
 */
export const MEMORY_SCHEMA_VERSION = 3;

interface VersionMarker {
	version: number;
}

/** What a run did, so the owner can be told the truth about their own files. */
export interface MigrationOutcome {
	/** The layout found on disk. 0 = written before the runner existed. */
	from: number;
	to: number;
	/** The steps that actually changed something, in the order they ran. */
	applied: string[];
	/** Contact facts were discarded by the memory-schema step. */
	factsCleared: number;
}

/** The legacy shapes, named so the code below reads like the files it is reading. */
type LegacySentRegistry = Record<string, number[]>;
interface LegacyConsolidationQueue {
	entries?: { chatId: string; userId?: string; activityAt: number }[];
}
interface LegacyChatCursors {
	cursors?: {
		chatId: string;
		handledThrough?: number;
		consolidatedThrough?: number;
	}[];
}
/** `personal`/`manager` today; `chat`/`log` before the rename. Both may carry names. */
interface LegacyTopics {
	ownerChatId?: number;
	personal?: number;
	manager?: number;
	chat?: number;
	log?: number;
	names?: Record<string, string>;
	archive?: number;
	used?: boolean;
	stale?: boolean;
}
/** `messageIds` today; a single `messageId` in the first version that pinned anything. */
interface LegacyModePin {
	ownerChatId?: number;
	messageId?: number;
	messageIds?: number[];
}

/**
 * Bring the extension directory up to {@link LAYOUT_VERSION}.
 *
 * Must run BEFORE the settings are read — it rewrites `settings.json` — and before any
 * store opens a file, because it is the thing that puts the files where the stores expect
 * them.
 */
export async function migrateStorage(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<MigrationOutcome> {
	const marker = await readJsonIfExists<VersionMarker>(
		fs,
		paths.schemaVersionPath,
	);
	const from = marker?.version ?? 0;
	const outcome: MigrationOutcome = {
		from,
		to: LAYOUT_VERSION,
		applied: [],
		factsCleared: 0,
	};
	if (from >= LAYOUT_VERSION) return outcome;

	// Snapshot what an OLDER version left here, BEFORE any step starts deleting it. The
	// fact step needs this and cannot ask later: by the time it runs, the steps above have
	// removed their sources, and "the file is not there" would look the same to it as "the
	// file was never there". See {@link migrateFacts} — the difference is somebody's memory.
	const hadLegacy = await anyLegacyFile(fs, paths);

	if (await migrateSettingsKeys(fs, paths)) outcome.applied.push("settings");
	if (await migrateChatState(fs, paths)) outcome.applied.push("chat-state");
	if (await migrateDmState(fs, paths)) outcome.applied.push("dm-state");
	const cleared = await migrateFacts(fs, paths, hadLegacy);
	if (cleared > 0) {
		outcome.applied.push("memory");
		outcome.factsCleared = cleared;
	}

	// Last, and only after every step above returned. A marker written over a half-done
	// migration is a migration that will never be finished.
	await writeJson<VersionMarker>(fs, paths.schemaVersionPath, {
		version: LAYOUT_VERSION,
	});
	return outcome;
}

/**
 * Rename the settings keys that were renamed in the code, in the owner's own file.
 *
 * The reader used to accept both spellings, which meant the file was never fixed and the
 * fallback could never be removed. Rewriting it once ends that — and only the keys we
 * renamed are touched: everything else in the file is written back exactly as it was
 * found, including anything we have never heard of.
 *
 * A backup is kept. This is the one file in the directory the OWNER wrote by hand, and
 * the only irreversible thing this runner does to it.
 */
async function migrateSettingsKeys(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<boolean> {
	const raw = await readJsonIfExists<Record<string, unknown>>(
		fs,
		paths.settingsPath,
	).catch(() => null);
	// Not there (a first run), or not an object (a broken file the loader will complain
	// about far more usefully than we can) — leave it alone.
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;

	const settings = { ...raw };
	let changed = false;

	const manager = asRecord(settings.manager);
	if (manager && "debugFeed" in manager) {
		const next = { ...manager };
		// The new key wins if the owner has already set it; the old one is dropped either
		// way, because a key nothing reads is a key that lies about what the bot will do.
		if (!("log" in next)) next.log = next.debugFeed;
		delete next.debugFeed;
		settings.manager = next;
		changed = true;
	}

	// The old two-topic layout is `chatName`/`logName`. Since then `logName` has been
	// GIVEN A NEW MEANING — the diagnostics topic's name — so it can no longer be treated
	// as legacy on its own: a new owner who sets `logName: "diag"` must keep it. The one
	// unambiguous signal of the old layout is `chatName`, a key with no new meaning at all.
	// So the rename fires ONLY when `chatName` is present; there, and only there, a sibling
	// `logName` is the old secretary-topic name and is consumed into `managerName`.
	const topics = asRecord(settings.topics);
	if (topics && "chatName" in topics) {
		const next = { ...topics };
		if (!("personalName" in next)) next.personalName = next.chatName;
		if (!("managerName" in next) && "logName" in next) {
			next.managerName = next.logName;
		}
		delete next.chatName;
		delete next.logName;
		settings.topics = next;
		changed = true;
	}

	if (!changed) return false;
	// The backup first: the only irreversible thing here is the line after it.
	await writeJson(fs, paths.legacy.settingsBackupPath, raw);
	await withFileWriteLock(paths.settingsPath, async () => {
		await writeJson(fs, paths.settingsPath, settings);
	});
	return true;
}

/** Three files that were always describing one chat → `chat-state.json`. */
async function migrateChatState(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<boolean> {
	const sent = await readJsonIfExists<LegacySentRegistry>(
		fs,
		paths.legacy.sentRegistryPath,
	).catch(() => null);
	const queue = await readJsonIfExists<LegacyConsolidationQueue>(
		fs,
		paths.legacy.consolidationQueuePath,
	).catch(() => null);
	const cursors = await readJsonIfExists<LegacyChatCursors>(
		fs,
		paths.legacy.chatCursorsPath,
	).catch(() => null);
	if (!sent && !queue && !cursors) return false;

	// Merge INTO whatever is already there. A run interrupted after the write but before
	// the deletes must not throw away what it wrote the first time.
	const records = new Map<string, ChatStateRecord>();
	const existing =
		(
			await readJsonIfExists<{ chats?: ChatStateRecord[] }>(
				fs,
				paths.chatStatePath,
			).catch(() => null)
		)?.chats ?? [];
	for (const record of existing) records.set(record.chatId, { ...record });

	const of = (chatId: string): ChatStateRecord => {
		const record = records.get(chatId) ?? { chatId };
		records.set(chatId, record);
		return record;
	};

	for (const [chatId, ids] of Object.entries(sent ?? {})) {
		if (!Array.isArray(ids)) continue;
		const record = of(chatId);
		// The union, then the same cap the store keeps: a merge must not be the one way a
		// chat's id list grows past the bound everything else respects.
		record.sent = [...new Set([...(record.sent ?? []), ...ids])].slice(
			-DEFAULT_MAX_SENT_PER_CHAT,
		);
	}
	for (const entry of queue?.entries ?? []) {
		if (!entry?.chatId) continue;
		const record = of(entry.chatId);
		// Never let a legacy file overwrite state that is already here. On the ordinary path
		// there is nothing to overwrite; the path that matters is a re-run (the marker was
		// removed by hand, a downgrade and an upgrade), where the file on disk is the NEWER
		// truth and the legacy one is a fossil. Additive merges (`sent`, and the cursors,
		// which take the max) are safe by construction. This one is not, so it is guarded.
		if (record.consolidation) continue;
		record.consolidation = {
			userId: entry.userId,
			activityAt: entry.activityAt,
		};
	}
	for (const cursor of cursors?.cursors ?? []) {
		if (!cursor?.chatId) continue;
		const record = of(cursor.chatId);
		record.handledThrough = maxOf(record.handledThrough, cursor.handledThrough);
		record.consolidatedThrough = maxOf(
			record.consolidatedThrough,
			cursor.consolidatedThrough,
		);
	}

	// Under the file's own lock. Nothing else should be running yet — the migration goes
	// before any store opens anything — but "should" is not an invariant, and this is.
	await withFileWriteLock(paths.chatStatePath, async () => {
		await writeJson(fs, paths.chatStatePath, { chats: [...records.values()] });
	});
	// Only now. Until this line the old files are the only copy that has been through a
	// full fsync-and-rename, and a crash between them is a crash we can recover from.
	await removeQuietly(fs, paths.legacy.sentRegistryPath);
	await removeQuietly(fs, paths.legacy.consolidationQueuePath);
	await removeQuietly(fs, paths.legacy.chatCursorsPath);
	return true;
}

/** The owner's DM: `topics.json` + `mode-pin.json` → `dm-state.json`. */
async function migrateDmState(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<boolean> {
	const topics = await readJsonIfExists<LegacyTopics>(
		fs,
		paths.legacy.topicsPath,
	).catch(() => null);
	const pin = await readJsonIfExists<LegacyModePin>(
		fs,
		paths.legacy.modePinPath,
	).catch(() => null);
	if (!topics && !pin) return false;

	const state: DmState<LegacyTopics> =
		(await readJsonIfExists<DmState<LegacyTopics>>(fs, paths.dmStatePath).catch(
			() => null,
		)) ?? {};

	// Same rule as the chat merge: what is already in the new file is the newer truth.
	if (state.topics === undefined && topics?.ownerChatId !== undefined) {
		// `chat`/`log` were renamed to `personal`/`manager`. The threads themselves are
		// real Telegram forum topics with the owner's history in them — adopting the ids is
		// the whole point, or a rename would orphan every message ever filed there.
		const personal = topics.personal ?? topics.chat;
		const manager = topics.manager ?? topics.log;
		if (personal !== undefined && manager !== undefined) {
			state.topics = {
				ownerChatId: topics.ownerChatId,
				personal,
				manager,
				...(topics.names !== undefined ? { names: topics.names } : {}),
				...(topics.archive !== undefined ? { archive: topics.archive } : {}),
				...(topics.used !== undefined ? { used: topics.used } : {}),
				...(topics.stale !== undefined ? { stale: topics.stale } : {}),
			};
		}
	}

	if (state.modePin === undefined && pin?.ownerChatId !== undefined) {
		// The first version pinned one message and stored one id; there may be several now.
		const messageIds = [
			...(pin.messageIds ?? []),
			...(pin.messageId !== undefined ? [pin.messageId] : []),
		];
		const merged: ModePin = { ownerChatId: pin.ownerChatId, messageIds };
		if (messageIds.length > 0) state.modePin = merged;
	}

	await withFileWriteLock(paths.dmStatePath, async () => {
		await writeJson(fs, paths.dmStatePath, state);
	});
	await removeQuietly(fs, paths.legacy.topicsPath);
	await removeQuietly(fs, paths.legacy.modePinPath);
	return true;
}

/**
 * The contact-fact schema, folded into the layout version.
 *
 * It had a marker file of its own, which is one file too many for one number. The rule is
 * unchanged: facts captured under older rules are discarded, not migrated, because a claim
 * about a person we can no longer vouch for is worse than no claim, and consolidation
 * re-derives them from transcripts that are clean.
 *
 * What is NOT unchanged is how "discard" is decided, and it is the most dangerous decision
 * in this file: it throws away what the bot has learned about real people.
 *
 * It used to read the absence of `memory-version.json` as "never migrated" and wipe. That
 * is wrong twice over. Facts are written by the manager, and the manager wrote that marker
 * on the start that preceded them — so an install holding facts but no marker cannot exist,
 * and the absence is not evidence of anything. And it is a trap: two Pi processes starting
 * at the same moment both begin migrating, the first deletes the marker, the second reaches
 * this step, finds it gone, and wipes the memory the first one had just decided to keep.
 *
 * So the wipe now needs POSITIVE evidence, and there are exactly two kinds:
 *
 *  - the marker is here and says an older fact schema (`< MEMORY_SCHEMA_VERSION`);
 *  - the marker is absent but this directory is demonstrably an old install — some other
 *    file from the old layout is here (`hadLegacy`, snapshotted before any step deleted
 *    anything). That is the install from before the marker existed at all.
 *
 * Anything else — a clean directory, or one another process has already migrated — keeps
 * its facts. When the two readings disagree, the one that does not destroy data wins.
 */
async function migrateFacts(
	fs: TelegramFs,
	paths: TelegramPaths,
	hadLegacy: boolean,
): Promise<number> {
	const marker = await readJsonIfExists<VersionMarker>(
		fs,
		paths.legacy.memoryVersionPath,
	).catch(() => null);
	const stale =
		marker !== null ? marker.version < MEMORY_SCHEMA_VERSION : hadLegacy;
	const cleared = stale ? await clearLegacyFacts(fs, paths) : 0;
	await removeQuietly(fs, paths.legacy.memoryVersionPath);
	return cleared;
}

/**
 * A contact file as it was written when facts lived in it. The live
 * {@link ContactStore} does not know this shape any more, which is the point: exactly
 * one place in the project reads a layout this version does not write, and it is here.
 */
interface LegacyContactRecord {
	facts?: LegacyFact[];
	[key: string]: unknown;
}

interface LegacyFact {
	text?: string;
	timestamp?: number;
	kind?: string;
	subject?: string;
}

/** Every contact file's user id. */
async function contactIds(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<string[]> {
	const entries = await safeReaddir(fs, paths.contactsDir);
	return entries
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length));
}

/**
 * Empty every contact's `facts` array, keeping the profile. Returns how many contacts
 * actually lost something — a directory with nothing in it is not an upgrade, and the
 * owner should not be told it was.
 */
async function clearLegacyFacts(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<number> {
	let cleared = 0;
	for (const userId of await contactIds(fs, paths)) {
		const path = paths.contactFile(userId);
		await withFileWriteLock(path, async () => {
			const record = await readJsonIfExists<LegacyContactRecord>(fs, path);
			if (!record?.facts?.length) return;
			record.facts = [];
			cleared += 1;
			await writeJson(fs, path, record);
		});
	}
	return cleared;
}

/** One fact carried out of a legacy contact file, ready to be re-remembered. */
export interface ImportedFact {
	text: string;
	kind: string;
	/** When the fact was learned, so the imported memory keeps its chronology. */
	timestamp: number;
}

/** What an import did, per contact. */
export interface FactImport {
	userId: string;
	facts: ImportedFact[];
}

/**
 * Read the facts still sitting in `contacts/*.json` and hand them back for writing
 * into the memory databases.
 *
 * Separate from {@link migrateStorage}, and not by preference: a memory database is
 * opened with the owner's embedder configuration, which is read from `settings.json`
 * — and the layout migration runs BEFORE the settings, because it is what makes them
 * readable. So the import is a second step, run once the workspace exists.
 *
 * It is idempotent through the data rather than through a marker: the caller clears
 * each contact's array once its facts are safely stored ({@link clearImportedFacts}),
 * so a second run finds nothing to do. Interrupted halfway, the facts it had not yet
 * cleared are still there, and re-storing one it already stored costs nothing — the
 * engine reports the duplicate instead of doubling it.
 */
export async function pendingFactImports(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<FactImport[]> {
	const imports: FactImport[] = [];
	for (const userId of await contactIds(fs, paths)) {
		const record = await readJsonIfExists<LegacyContactRecord>(
			fs,
			paths.contactFile(userId),
		).catch(() => null);
		const facts = (record?.facts ?? [])
			.filter((fact): fact is LegacyFact & { text: string } =>
				Boolean(fact?.text?.trim()),
			)
			.map((fact) => ({
				text: fact.text.trim(),
				kind: fact.kind ?? "context",
				timestamp: fact.timestamp ?? 0,
			}));
		if (facts.length > 0) imports.push({ userId, facts });
	}
	return imports;
}

/**
 * Move every fact still sitting in `contacts/*.json` into that contact's memory
 * database, then empty the array it came from.
 *
 * Order matters and is the file's standing rule: write the new home first, clear the
 * old one only once the write returned. Interrupted between the two, the next run
 * finds the facts still in the JSON and stores them again — a duplicate, and the
 * deliberate choice between the two ways of being wrong here. The guarded write would
 * refuse the second copy, and would equally refuse two legacy facts that merely read
 * alike, dropping one of them on the floor during the one operation that is supposed
 * to lose nothing. A duplicate is visible and removable; a fact silently not migrated
 * is neither.
 *
 * A contact whose database will not open is SKIPPED, not emptied: their facts stay
 * exactly where they are, and the next start tries again. A migration that cannot do
 * its job leaves its sources alone.
 *
 * `onContact` reports each contact that actually moved something, so the owner is told
 * what happened to their data rather than finding it changed.
 */
export async function importLegacyFacts(
	fs: TelegramFs,
	paths: TelegramPaths,
	memory: MemoryWorkspace,
	onContact?: (userId: string, count: number) => void,
): Promise<number> {
	let moved = 0;
	for (const pending of await pendingFactImports(fs, paths)) {
		const record = await readJsonIfExists<{
			profile?: { displayName?: string };
		}>(fs, paths.contactFile(pending.userId)).catch(() => null);
		const entity = record?.profile?.displayName;
		try {
			const database = await memory.for(pending.userId);
			// One batch, so a contact's facts arrive together or not at all — which is
			// what makes the clearing step below safe to run against "the write
			// returned" rather than against a count of how many of them made it.
			await database.rememberMany(
				pending.facts.map((fact) => ({
					text: fact.text,
					entity,
					tags: ["fact", fact.kind, "migrated"],
					// The chronology survives the move: a fact learned in March keeps saying
					// so, which is what makes an as-of question about March answerable.
					validFrom: fact.timestamp > 0 ? fact.timestamp : undefined,
				})),
			);
		} catch {
			continue;
		}
		await clearImportedFacts(fs, paths, pending.userId);
		moved += pending.facts.length;
		onContact?.(pending.userId, pending.facts.length);
	}
	return moved;
}

/** Drop one contact's legacy facts, once they are stored somewhere better. */
export async function clearImportedFacts(
	fs: TelegramFs,
	paths: TelegramPaths,
	userId: string,
): Promise<void> {
	const path = paths.contactFile(userId);
	await withFileWriteLock(path, async () => {
		const record = await readJsonIfExists<LegacyContactRecord>(fs, path);
		if (!record?.facts?.length) return;
		record.facts = [];
		await writeJson(fs, path, record);
	});
}

/** Did an older version of this extension leave anything here? Asked once, first. */
async function anyLegacyFile(
	fs: TelegramFs,
	paths: TelegramPaths,
): Promise<boolean> {
	for (const path of [
		paths.legacy.sentRegistryPath,
		paths.legacy.consolidationQueuePath,
		paths.legacy.chatCursorsPath,
		paths.legacy.topicsPath,
		paths.legacy.modePinPath,
		paths.legacy.memoryVersionPath,
	]) {
		if (await fs.exists(path)) return true;
	}
	return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function maxOf(
	a: number | undefined,
	b: number | undefined,
): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

/** A file that is already gone is a file that does not need removing. */
async function removeQuietly(fs: TelegramFs, path: string): Promise<void> {
	await fs.removeFile(path).catch(() => {});
}
