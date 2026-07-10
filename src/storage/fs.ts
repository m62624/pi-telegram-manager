import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "../errors";

/**
 * Filesystem port. Every store takes this as its first argument (dependency
 * injection) so tests can substitute an in-memory fake (see `tests/helpers`)
 * without touching the real disk.
 */
export interface TelegramFs {
	exists(path: string): Promise<boolean>;
	isDirectory(path: string): Promise<boolean>;
	mkdirp(path: string): Promise<void>;
	/** Move a file or directory; parent of `dst` is created first. */
	move(src: string, dst: string): Promise<void>;
	readText(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	removeDir(path: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	writeText(path: string, content: string): Promise<void>;
	/** Write raw bytes (creating parents), for saving inbound Telegram files. */
	writeBytes(path: string, bytes: Uint8Array): Promise<void>;
	/** Crash-safe write via temp-file + rename. Never observes a partial file. */
	writeTextAtomic(path: string, content: string): Promise<void>;
	/** Append to a file (creating it + parents if missing). Used for JSONL logs. */
	appendText(path: string, content: string): Promise<void>;
}

export function createNodeFs(): TelegramFs {
	return {
		async exists(path) {
			try {
				await stat(path);
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return false;
				}
				throw error;
			}
		},
		async isDirectory(path) {
			try {
				return (await stat(path)).isDirectory();
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return false;
				}
				throw error;
			}
		},
		async mkdirp(path) {
			await mkdir(path, { recursive: true });
		},
		async move(src, dst) {
			await mkdir(dirname(dst), { recursive: true });
			await rename(src, dst);
		},
		async readText(path) {
			return await readFile(path, "utf8");
		},
		async readdir(path) {
			return await readdir(path);
		},
		async removeDir(path) {
			await rm(path, { recursive: true, force: true });
		},
		async removeFile(path) {
			try {
				await unlink(path);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return;
				}
				throw error;
			}
		},
		async writeText(path, content) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
		async writeBytes(path, bytes) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, bytes);
		},
		async writeTextAtomic(path, content) {
			// Write-then-rename: a crash or concurrent read mid-write can never
			// observe a partial file. Every JSON store depends on this — swapping in
			// `writeText` here would let a crash corrupt singleton/business state.
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
		},
		async appendText(path, content) {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, content, "utf8");
		},
	};
}

/**
 * List a directory, returning an empty array if it cannot be read (missing,
 * not a directory, permission denied). Lets callers treat "no entries" and
 * "no such directory" uniformly when scanning optional locations.
 */
export async function safeReaddir(
	fs: TelegramFs,
	path: string,
): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch {
		return [];
	}
}
