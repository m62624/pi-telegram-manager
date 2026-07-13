import type { BridgeMode } from "../constants";
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/**
 * The single source of truth for "which mode is active right now". Persisted
 * atomically. `pid` + `heartbeatAt` let a fresh process detect a crashed owner
 * and reset to "nothing active" (default OFF) rather than auto-resuming.
 */
export interface TelegramSingletonRecord {
	mode: BridgeMode;
	pid: number;
	instanceId: string;
	startedAt: number;
	/** Timestamp (ms) of the last heartbeat; compared against a timeout. */
	heartbeatAt: number;
	/** Mode 1: the bound DM chat. Mode 2: unused. */
	chatId?: string;
	/** The Pi session file this bridge is bound to. */
	sessionFile?: string;
	/** Mode 2: directory the manager session was opened in. */
	workdir?: string;
}

export interface SingletonStalenessOptions {
	now: number;
	ownPid: number;
	heartbeatTimeoutMs: number;
	isPidAlive: (pid: number) => boolean;
}

/**
 * A record is stale — its owner crashed/exited — when the owning process is
 * gone OR its heartbeat lapsed. A stale record must be treated as "inactive"
 * (mode default OFF) and cleared. A record owned by *this* pid is never stale.
 */
export function isSingletonStale(
	record: TelegramSingletonRecord,
	opts: SingletonStalenessOptions,
): boolean {
	if (record.pid === opts.ownPid) {
		return false;
	}
	if (!opts.isPidAlive(record.pid)) {
		return true;
	}
	return opts.now - record.heartbeatAt > opts.heartbeatTimeoutMs;
}

export interface SingletonStore {
	/** Read the raw persisted record (no staleness interpretation). */
	load(): Promise<TelegramSingletonRecord | null>;
	/** Persist (overwrite) the record atomically. */
	save(record: TelegramSingletonRecord): Promise<void>;
	/**
	 * Read-modify-write under the file lock. `mutate` receives the current
	 * record (or null) and returns the next record, or null to clear the file.
	 */
	update(
		mutate: (
			current: TelegramSingletonRecord | null,
		) => TelegramSingletonRecord | null,
	): Promise<TelegramSingletonRecord | null>;
	/** Remove the record (explicit disable). */
	clear(): Promise<void>;
}

export function createSingletonStore(
	fs: TelegramFs,
	path: string,
): SingletonStore {
	return {
		async load() {
			return await readJsonIfExists<TelegramSingletonRecord>(fs, path);
		},
		async save(record) {
			await withFileWriteLock(path, () => writeJson(fs, path, record));
		},
		async update(mutate) {
			return await withFileWriteLock(path, async () => {
				const current = await readJsonIfExists<TelegramSingletonRecord>(
					fs,
					path,
				);
				const next = mutate(current);
				if (next === null) {
					await fs.removeFile(path);
				} else {
					await writeJson(fs, path, next);
				}
				return next;
			});
		},
		async clear() {
			await withFileWriteLock(path, () => fs.removeFile(path));
		},
	};
}
