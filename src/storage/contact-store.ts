/**
 * ACID per-contact store: one JSON file per Telegram user holding their latest
 * {@link TelegramProfile} plus a running list of curated "important facts".
 *
 * Shared by both modes — mode 1 records the person on the other end of the
 * terminal bridge, mode 2's manager records each business contact — so the
 * manager can later resurface a contact's important facts when it resumes their
 * chat. Profile writes merge over the stored record (see `mergeProfile`) so a
 * detail learned once (a phone number, a bio) is never lost by a later plain
 * message update. All mutations are read-modify-write under an in-process file
 * lock, mirroring `business-store`.
 */
import type { TelegramProfile } from "../telegram/profile";
import { mergeProfile } from "../telegram/profile";
import { withFileWriteLock } from "./file-lock";
import { safeReaddir, type TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";
import type { TelegramPaths } from "./paths";

/**
 * How a durable fact shapes the model's behaviour when resurfaced. Each kind maps
 * to a distinct instruction in the "Known facts" block (see the manager
 * controller's `knownFactsBlock`), so a fact does work rather than being a flat
 * note:
 *  - `identity`   — who they are (name, role, city): ground answers, address correctly;
 *  - `preference` — likes/dislikes/style/language: adapt tone and format;
 *  - `agreement`  — commitments/promises: honour and follow up on them;
 *  - `context`    — an ongoing situation: background that may go stale.
 */
export type FactKind = "identity" | "preference" | "agreement" | "context";

export const FACT_KINDS: readonly FactKind[] = [
	"identity",
	"preference",
	"agreement",
	"context",
];

/** One curated fact about a contact (added manually or, later, by the manager). */
export interface ContactFact {
	text: string;
	timestamp: number;
	/** Where the fact came from, e.g. "manual", "manager". */
	source?: string;
	/**
	 * The confirmed person this fact is about (the contact's display name at
	 * capture). A fact is only ever stored about the interlocutor, so this makes
	 * a misattribution (e.g. the owner's name here) visible and auditable.
	 */
	subject?: string;
	/** How this fact should steer the model when resurfaced. */
	kind?: FactKind;
}

/** Everything persisted about one contact. */
export interface ContactRecord {
	profile: TelegramProfile;
	facts: ContactFact[];
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
	/** Append an important fact to a contact (the record must already exist). */
	addFact(userId: string, fact: ContactFact): Promise<void>;
	/**
	 * Append several facts at once, keeping only the newest `limit` (when given).
	 * No-op for an unknown contact.
	 */
	appendFacts(
		userId: string,
		facts: ContactFact[],
		limit?: number,
	): Promise<void>;
	/** A contact's important facts, oldest-first (empty when none/unseen). */
	getFacts(userId: string): Promise<ContactFact[]>;
	/**
	 * Wipe every contact's `facts` list (profiles kept). Used by the one-off memory
	 * migration when the fact schema changes, so stale mis-attributed facts don't
	 * linger under the new rules.
	 */
	clearAllFacts(): Promise<void>;
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
							facts: existing.facts,
							firstSeen: existing.firstSeen,
							updatedAt: now,
						}
					: { profile, facts: [], firstSeen: now, updatedAt: now };
				await writeJson(fs, path, record);
				return record;
			});
		},

		async addFact(userId, fact) {
			const path = paths.contactFile(userId);
			await withFileWriteLock(path, async () => {
				const existing = await read(userId);
				if (!existing) return; // a fact needs a known contact
				existing.facts.push(fact);
				existing.updatedAt = fact.timestamp;
				await writeJson(fs, path, existing);
			});
		},

		async appendFacts(userId, facts, limit) {
			if (facts.length === 0) return;
			const path = paths.contactFile(userId);
			await withFileWriteLock(path, async () => {
				const existing = await read(userId);
				if (!existing) return; // facts need a known contact
				existing.facts.push(...facts);
				if (limit !== undefined && existing.facts.length > limit) {
					existing.facts = existing.facts.slice(-limit);
				}
				existing.updatedAt = facts[facts.length - 1].timestamp;
				await writeJson(fs, path, existing);
			});
		},

		async getFacts(userId) {
			const record = await read(userId);
			return record?.facts ?? [];
		},

		async clearAllFacts() {
			const entries = await safeReaddir(fs, paths.contactsDir);
			for (const name of entries) {
				if (!name.endsWith(".json")) continue;
				const userId = name.slice(0, -".json".length);
				const path = paths.contactFile(userId);
				await withFileWriteLock(path, async () => {
					const existing = await read(userId);
					if (!existing || existing.facts.length === 0) return;
					existing.facts = [];
					await writeJson(fs, path, existing);
				});
			}
		},
	};
}
