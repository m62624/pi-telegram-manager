/**
 * ACID per-contact store: one JSON file per Telegram user holding their latest
 * {@link TelegramProfile}.
 *
 * Shared by both modes — mode 1 records the person on the other end of the terminal
 * bridge, mode 2's manager records each business contact. Profile writes merge over
 * the stored record (see `mergeProfile`) so a detail learned once (a phone number, a
 * bio) is never lost by a later plain message update. All mutations are
 * read-modify-write under an in-process file lock, mirroring `business-store`.
 *
 * It used to hold the contact's facts too, in a capped array. Those live in a
 * database of their own now — one per contact, see `storage/memory.ts` — because a
 * fact needs to be searched, superseded and kept beyond the twenty that fitted here,
 * and none of that is what a profile record is for. A profile is read back verbatim;
 * a memory is queried. The only thing left of the old array is the migration that
 * empties it (`storage/migrations.ts`).
 */
import type { TelegramProfile } from "../telegram/profile";
import { mergeProfile } from "../telegram/profile";
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";
import type { TelegramPaths } from "./paths";

/** Everything persisted about one contact. */
export interface ContactRecord {
	profile: TelegramProfile;
	firstSeen: number;
	updatedAt: number;
}

export interface ContactStore {
	/** The stored record for a user, or null when unseen. */
	get(userId: string): Promise<ContactRecord | null>;
	/**
	 * Merge a freshly-extracted profile into the stored record (creating it on
	 * first contact) and return the updated record.
	 */
	upsertProfile(profile: TelegramProfile, now: number): Promise<ContactRecord>;
}

export function createContactStore(
	fs: TelegramFs,
	paths: TelegramPaths,
): ContactStore {
	async function read(userId: string): Promise<ContactRecord | null> {
		return (
			(await readJsonIfExists<ContactRecord>(fs, paths.contactFile(userId))) ??
			null
		);
	}

	return {
		get: read,

		async upsertProfile(profile, now) {
			const path = paths.contactFile(profile.userId);
			return withFileWriteLock(path, async () => {
				const existing = await read(profile.userId);
				const record: ContactRecord = existing
					? {
							profile: mergeProfile(existing.profile, profile),
							firstSeen: existing.firstSeen,
							updatedAt: now,
						}
					: { profile, firstSeen: now, updatedAt: now };
				await writeJson(fs, path, record);
				return record;
			});
		},
	};
}
