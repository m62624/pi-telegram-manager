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
	/**
	 * Drop facts by their text (matched as {@link factKey}, so spacing and a trailing
	 * full stop do not save a fact from being forgotten). Returns how many went.
	 */
	removeFacts(userId: string, texts: readonly string[]): Promise<number>;
	/** A contact's important facts, oldest-first (empty when none/unseen). */
	getFacts(userId: string): Promise<ContactFact[]>;
	/**
	 * Wipe every contact's `facts` list (profiles kept). Used by the one-off memory
	 * migration when the fact schema changes, so stale mis-attributed facts don't
	 * linger under the new rules.
	 */
	clearAllFacts(): Promise<void>;
}

/**
 * A fact's identity: what it says, with nothing that is not what it says. Case, spacing
 * and a trailing full stop are how the same sentence comes back looking different.
 */
export function factKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.!…\s]+$/u, "")
		.trim();
}

/**
 * The facts in `incoming` that `existing` does not already hold — and the reason this
 * function exists at all.
 *
 * A memory pass re-runs over a chat whenever it gets new messages, and it re-confirms
 * what it confirmed last time: the same sentence, verified against the same quote, is
 * genuinely true again. Appended blindly, "true again" became "stored again". In the
 * owner's live store one contact's memory was five facts, three of which were the same
 * line — and because `factsLimit` keeps the NEWEST facts, a repeat does not just take up
 * room, it evicts a real fact to do it. Memory that fills up with one sentence.
 *
 * Deduping on write also makes an interrupted pass free to redo (see
 * `ManagerController.persistConfirmed`): learn a fact twice, store it once.
 */
export function newFacts(
	existing: readonly ContactFact[],
	incoming: readonly ContactFact[],
): ContactFact[] {
	const seen = new Set(existing.map((fact) => factKey(fact.text)));
	const fresh: ContactFact[] = [];
	for (const fact of incoming) {
		const key = factKey(fact.text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		fresh.push(fact);
	}
	return fresh;
}

/** Facts with the repeats removed, keeping the FIRST time each one was learned. */
export function dedupeFacts(facts: readonly ContactFact[]): ContactFact[] {
	return newFacts([], facts);
}

/**
 * What a fact is worth keeping when the memory is full — lowest goes first.
 *
 * `context` is documented as "an ongoing situation: background that may go stale", and
 * that is exactly what it is: the most disposable thing in the file. `identity` is who
 * the person IS, and `agreement` is what was promised to them; losing either to make
 * room for "is travelling this week" is how a bot forgets a commitment and remembers a
 * mood.
 */
const KEEP_RANK: Record<FactKind, number> = {
	context: 0,
	preference: 1,
	agreement: 2,
	identity: 3,
};

/**
 * Trim a fact list to `limit`, dropping the least valuable first — and only then the
 * oldest.
 *
 * It used to be `slice(-limit)`: keep the newest, whatever they are. So a contact's name
 * and city, learned the day they first wrote, were evicted by a week of "is at the
 * office today" — and the memory that remained was the one worth the least. Age is the
 * tie-breaker now, not the rule.
 */
export function capFacts(
	facts: readonly ContactFact[],
	limit: number,
): ContactFact[] {
	if (limit <= 0) return [];
	if (facts.length <= limit) return [...facts];
	const ranked = facts.map((fact, index) => ({ fact, index }));
	ranked.sort((a, b) => {
		const rank =
			KEEP_RANK[a.fact.kind ?? "context"] - KEEP_RANK[b.fact.kind ?? "context"];
		// Least valuable first; among equals, the oldest first — those are the ones to go.
		return rank !== 0 ? rank : a.index - b.index;
	});
	const doomed = new Set(
		ranked.slice(0, facts.length - limit).map((e) => e.index),
	);
	// Survivors keep their original order: the file stays a chronology.
	return facts.filter((_, index) => !doomed.has(index));
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
				const [kept] = newFacts(existing.facts, [fact]);
				if (!kept) return; // already known — nothing to write
				existing.facts.push(kept);
				existing.updatedAt = kept.timestamp;
				await writeJson(fs, path, existing);
			});
		},

		async appendFacts(userId, facts, limit) {
			if (facts.length === 0) return;
			const path = paths.contactFile(userId);
			await withFileWriteLock(path, async () => {
				const existing = await read(userId);
				if (!existing) return; // facts need a known contact
				const fresh = newFacts(existing.facts, facts);
				if (fresh.length === 0) return;
				existing.facts.push(...fresh);
				if (limit !== undefined) {
					existing.facts = capFacts(existing.facts, limit);
				}
				existing.updatedAt = fresh[fresh.length - 1].timestamp;
				await writeJson(fs, path, existing);
			});
		},

		async removeFacts(userId, texts) {
			if (texts.length === 0) return 0;
			const path = paths.contactFile(userId);
			return withFileWriteLock(path, async () => {
				const existing = await read(userId);
				if (!existing) return 0;
				const doomed = new Set(texts.map(factKey).filter(Boolean));
				const kept = existing.facts.filter(
					(fact) => !doomed.has(factKey(fact.text)),
				);
				const gone = existing.facts.length - kept.length;
				if (gone === 0) return 0;
				existing.facts = kept;
				await writeJson(fs, path, existing);
				return gone;
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
