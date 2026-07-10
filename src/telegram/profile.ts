/**
 * Extract everything Telegram lets a bot learn about a person, into one flat,
 * SDK-agnostic {@link TelegramProfile}. This is the shared source of interlocutor
 * data for both modes: mode 1 records who is on the other end of the terminal
 * bridge, mode 2's manager records each business contact (and later relays their
 * important facts).
 *
 * Pure — it reads grammY message objects into a plain record with no I/O — so it
 * is fully unit-testable and stays independent of `contact-store` (which
 * persists what this produces).
 *
 * Field availability, by source:
 *  - `User` (on every message): id, is_bot, first/last name, username,
 *    language_code, is_premium, added_to_attachment_menu — always present.
 *  - `Contact` (only when the user shares their contact card): phone_number.
 *  - `getChat` extended info (a network call, mode 2): bio.
 */
import type { Contact, User } from "@grammyjs/types";

/** Flattened, persistable view of a Telegram person. */
export interface TelegramProfile {
	/** Telegram user id, stringified (the contact-store key). */
	userId: string;
	isBot?: boolean;
	firstName?: string;
	lastName?: string;
	/** Handle without the leading `@`. */
	username?: string;
	languageCode?: string;
	isPremium?: boolean;
	addedToAttachmentMenu?: boolean;
	/** Only known once the user shares their contact card. */
	phoneNumber?: string;
	/** Only known via `getChat` extended info (mode 2). */
	bio?: string;
	/** Best-effort display name derived from the fields above. */
	displayName: string;
}

/** Full name, else @username, else `User <id>`. */
function deriveDisplayName(
	profile: Omit<TelegramProfile, "displayName">,
): string {
	const full = [profile.firstName, profile.lastName]
		.filter(Boolean)
		.join(" ")
		.trim();
	if (full) return full;
	if (profile.username) return `@${profile.username}`;
	return `User ${profile.userId}`;
}

/** Build a profile from the `User` object present on every message. */
export function extractProfileFromUser(user: User): TelegramProfile {
	const base: Omit<TelegramProfile, "displayName"> = {
		userId: String(user.id),
		isBot: user.is_bot,
		firstName: user.first_name,
		lastName: user.last_name,
		username: user.username,
		languageCode: user.language_code,
		isPremium: user.is_premium,
		addedToAttachmentMenu: user.added_to_attachment_menu,
	};
	return { ...base, displayName: deriveDisplayName(base) };
}

/**
 * Merge a shared contact card's phone number into a profile, but only when the
 * card belongs to this same user (Telegram lets people forward *others'*
 * contacts, which must not be attributed here).
 */
export function withContact(
	profile: TelegramProfile,
	contact: Contact,
): TelegramProfile {
	const sameUser =
		contact.user_id === undefined || String(contact.user_id) === profile.userId;
	if (!sameUser || !contact.phone_number) return profile;
	return { ...profile, phoneNumber: contact.phone_number };
}

/** Merge extended `getChat` info (currently just bio) into a profile. */
export function withChatInfo(
	profile: TelegramProfile,
	info: { bio?: string },
): TelegramProfile {
	return info.bio ? { ...profile, bio: info.bio } : profile;
}

/**
 * Merge a newer profile over an older stored one, keeping any field the newer
 * capture lacks (e.g. a `phoneNumber`/`bio` learned earlier from a one-off
 * source shouldn't be dropped by a plain message update). Non-empty new values
 * win; the display name is recomputed.
 */
export function mergeProfile(
	previous: TelegramProfile,
	next: TelegramProfile,
): TelegramProfile {
	const merged: Omit<TelegramProfile, "displayName"> = {
		userId: next.userId,
		isBot: next.isBot ?? previous.isBot,
		firstName: next.firstName ?? previous.firstName,
		lastName: next.lastName ?? previous.lastName,
		username: next.username ?? previous.username,
		languageCode: next.languageCode ?? previous.languageCode,
		isPremium: next.isPremium ?? previous.isPremium,
		addedToAttachmentMenu:
			next.addedToAttachmentMenu ?? previous.addedToAttachmentMenu,
		phoneNumber: next.phoneNumber ?? previous.phoneNumber,
		bio: next.bio ?? previous.bio,
	};
	return { ...merged, displayName: deriveDisplayName(merged) };
}
