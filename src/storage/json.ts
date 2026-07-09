import type { TelegramFs } from "./fs";

/** Thrown when a JSON file cannot be parsed. Carries the offending path. */
export class TelegramJsonError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "TelegramJsonError";
	}
}

export async function readJson<T>(fs: TelegramFs, path: string): Promise<T> {
	try {
		return JSON.parse(await fs.readText(path)) as T;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new TelegramJsonError(
				`Invalid JSON at ${path}: ${error.message}`,
				path,
			);
		}
		throw error;
	}
}

export async function writeJson<T>(
	fs: TelegramFs,
	path: string,
	value: T,
): Promise<void> {
	// Always atomic: crash mid-write never corrupts the target record.
	await fs.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonIfExists<T>(
	fs: TelegramFs,
	path: string,
): Promise<T | null> {
	if (!(await fs.exists(path))) {
		return null;
	}
	return await readJson<T>(fs, path);
}
