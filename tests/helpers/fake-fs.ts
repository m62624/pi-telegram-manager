import { dirname } from "node:path";
import type { TelegramFs } from "../../src/storage/fs";

/**
 * In-memory {@link TelegramFs} for tests. Files are a flat path→content map;
 * directories are implied by file paths (plus any explicitly created via
 * mkdirp/writeText). Good enough to exercise every store without touching disk.
 */
export class FakeFs implements TelegramFs {
	readonly files = new Map<string, string>();
	private readonly dirs = new Set<string>(["/"]);

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}

	async isDirectory(path: string): Promise<boolean> {
		return this.dirs.has(path);
	}

	async mkdirp(path: string): Promise<void> {
		let current = path;
		while (current && !this.dirs.has(current)) {
			this.dirs.add(current);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	async move(src: string, dst: string): Promise<void> {
		if (this.files.has(src)) {
			const content = this.files.get(src) ?? "";
			this.files.delete(src);
			await this.writeText(dst, content);
			return;
		}
		// Move a directory subtree.
		for (const [key, value] of [...this.files]) {
			if (key === src || key.startsWith(`${src}/`)) {
				this.files.delete(key);
				this.files.set(dst + key.slice(src.length), value);
			}
		}
	}

	async readText(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) {
			const error = new Error(
				`ENOENT: no such file or directory, open '${path}'`,
			) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		return content;
	}

	async readdir(path: string): Promise<string[]> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const entries = new Set<string>();
		for (const key of [...this.files.keys(), ...this.dirs]) {
			if (key.startsWith(prefix)) {
				const rest = key.slice(prefix.length);
				const first = rest.split("/")[0];
				if (first) entries.add(first);
			}
		}
		return [...entries];
	}

	async removeDir(path: string): Promise<void> {
		for (const key of [...this.files.keys()]) {
			if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
		}
		for (const key of [...this.dirs]) {
			if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
		}
	}

	async removeFile(path: string): Promise<void> {
		this.files.delete(path);
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.mkdirp(dirname(path));
		this.files.set(path, content);
	}

	async writeTextAtomic(path: string, content: string): Promise<void> {
		await this.writeText(path, content);
	}

	async appendText(path: string, content: string): Promise<void> {
		const existing = this.files.get(path) ?? "";
		await this.writeText(path, existing + content);
	}
}
