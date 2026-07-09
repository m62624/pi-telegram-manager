import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/**
 * A connected Telegram business account, flattened from the `BusinessConnection`
 * update. The `id` is the `business_connection_id` used to send replies AS the
 * owner — treat this file as sensitive.
 */
export interface StoredBusinessConnection {
	id: string;
	userId: string;
	userChatId?: string;
	userName?: string;
	canReply?: boolean;
	canReadMessages?: boolean;
	isEnabled: boolean;
	connectedAt: number;
	updatedAt: number;
}

type BusinessMap = Record<string, StoredBusinessConnection>;

export interface BusinessStore {
	upsert(connection: StoredBusinessConnection): Promise<void>;
	get(id: string): Promise<StoredBusinessConnection | null>;
	all(): Promise<StoredBusinessConnection[]>;
	remove(id: string): Promise<void>;
}

export function createBusinessStore(
	fs: TelegramFs,
	path: string,
): BusinessStore {
	async function readMap(): Promise<BusinessMap> {
		return (await readJsonIfExists<BusinessMap>(fs, path)) ?? {};
	}

	return {
		async upsert(connection) {
			await withFileWriteLock(path, async () => {
				const map = await readMap();
				map[connection.id] = connection;
				await writeJson(fs, path, map);
			});
		},
		async get(id) {
			const map = await readMap();
			return map[id] ?? null;
		},
		async all() {
			return Object.values(await readMap());
		},
		async remove(id) {
			await withFileWriteLock(path, async () => {
				const map = await readMap();
				delete map[id];
				await writeJson(fs, path, map);
			});
		},
	};
}
