import type { Contact, User } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
	extractProfileFromUser,
	mergeProfile,
	withChatInfo,
	withContact,
} from "../../src/telegram/profile";

const user = (over: Partial<User> = {}): User => ({
	id: 42,
	is_bot: false,
	first_name: "Ada",
	...over,
});

describe("extractProfileFromUser", () => {
	it("captures every field Telegram provides on a User", () => {
		const profile = extractProfileFromUser(
			user({
				last_name: "Lovelace",
				username: "ada",
				language_code: "en",
				is_premium: true,
				added_to_attachment_menu: true,
			}),
		);
		expect(profile).toEqual({
			userId: "42",
			isBot: false,
			firstName: "Ada",
			lastName: "Lovelace",
			username: "ada",
			languageCode: "en",
			isPremium: true,
			addedToAttachmentMenu: true,
			displayName: "Ada Lovelace",
		});
	});

	it("derives displayName: full name → @username → User <id>", () => {
		expect(extractProfileFromUser(user()).displayName).toBe("Ada");
		expect(
			extractProfileFromUser(user({ first_name: "", username: "ada" }))
				.displayName,
		).toBe("@ada");
		expect(
			extractProfileFromUser(user({ first_name: "", username: undefined }))
				.displayName,
		).toBe("User 42");
	});
});

describe("withContact", () => {
	const base = extractProfileFromUser(user());
	const contact = (over: Partial<Contact> = {}): Contact => ({
		phone_number: "+100",
		first_name: "Ada",
		...over,
	});

	it("adds the phone number when the card is the same user", () => {
		expect(withContact(base, contact({ user_id: 42 })).phoneNumber).toBe(
			"+100",
		);
		expect(withContact(base, contact({ user_id: undefined })).phoneNumber).toBe(
			"+100",
		);
	});

	it("ignores a forwarded contact card for a different user", () => {
		expect(
			withContact(base, contact({ user_id: 999 })).phoneNumber,
		).toBeUndefined();
	});
});

describe("withChatInfo", () => {
	it("merges a bio when present, otherwise no-ops", () => {
		const base = extractProfileFromUser(user());
		expect(withChatInfo(base, { bio: "builds engines" }).bio).toBe(
			"builds engines",
		);
		expect(withChatInfo(base, {})).toBe(base);
	});
});

describe("mergeProfile", () => {
	it("keeps older fields the newer capture lacks and recomputes displayName", () => {
		const previous = { ...extractProfileFromUser(user()), phoneNumber: "+100" };
		const next = extractProfileFromUser(
			user({ last_name: "Lovelace", first_name: "Ada" }),
		);
		const merged = mergeProfile(previous, next);
		expect(merged.phoneNumber).toBe("+100"); // not dropped
		expect(merged.lastName).toBe("Lovelace"); // updated
		expect(merged.displayName).toBe("Ada Lovelace");
	});
});
