import { describe, expect, it } from "vitest";
import {
	BOT_MARKER,
	hasBotMarker,
	isBotMessage,
	stripBotMarker,
	tagBotText,
} from "../../../src/modes/manager/identity";
import type { SentRegistry } from "../../../src/storage/chat-state";

function fakeRegistry(known: Record<string, number[]> = {}): SentRegistry {
	return {
		async recordSent(chatId, id) {
			known[chatId] ??= [];
			known[chatId].push(id);
		},
		async wasSentByBot(chatId, id) {
			return (known[chatId] ?? []).includes(id);
		},
	};
}

describe("bot marker", () => {
	it("is invisible (zero-width only) and round-trips", () => {
		expect([...BOT_MARKER].every((c) => c.charCodeAt(0) >= 0x2000)).toBe(true);
		const tagged = tagBotText("hello");
		expect(hasBotMarker(tagged)).toBe(true);
		expect(stripBotMarker(tagged)).toBe("hello");
		expect(hasBotMarker("hello")).toBe(false);
	});
});

describe("isBotMessage", () => {
	it("detects the bot via the hidden marker regardless of the registry", async () => {
		const reg = fakeRegistry();
		expect(
			await isBotMessage(
				{ chatId: "c", messageId: 5, text: tagBotText("hi") },
				reg,
			),
		).toBe(true);
	});

	it("detects the bot via the sent registry when the marker is gone", async () => {
		const reg = fakeRegistry({ c: [5] });
		expect(
			await isBotMessage({ chatId: "c", messageId: 5, text: "hi" }, reg),
		).toBe(true);
	});

	it("treats an unmarked, unregistered message as the owner's", async () => {
		const reg = fakeRegistry({ c: [5] });
		expect(
			await isBotMessage({ chatId: "c", messageId: 9, text: "manual" }, reg),
		).toBe(false);
		expect(await isBotMessage({ chatId: "c", text: "no id" }, reg)).toBe(false);
	});
});
