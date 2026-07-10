import type { Update } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_ALLOWED_UPDATES,
	dispatchUpdate,
	fetchBytesFromUrl,
	fileBaseUrl,
} from "../../src/telegram/client";
import type { TelegramEvent } from "../../src/telegram/updates";

describe("fileBaseUrl", () => {
	it("builds the file download base url without a trailing slash", () => {
		expect(fileBaseUrl("123:ABC")).toBe(
			"https://api.telegram.org/file/bot123:ABC",
		);
	});
});

describe("DEFAULT_ALLOWED_UPDATES", () => {
	it("includes the business updates Telegram omits by default", () => {
		for (const kind of [
			"business_connection",
			"business_message",
			"edited_business_message",
			"deleted_business_messages",
		]) {
			expect(DEFAULT_ALLOWED_UPDATES).toContain(kind);
		}
	});
});

describe("dispatchUpdate", () => {
	it("classifies the update and forwards the event", async () => {
		const events: TelegramEvent[] = [];
		const update = {
			update_id: 1,
			message: {
				message_id: 1,
				date: 0,
				chat: { id: 42, type: "private", first_name: "A" },
				from: { id: 7, is_bot: false, first_name: "A" },
				text: "hi",
			},
		} as Update;
		await dispatchUpdate(update, (event) => {
			events.push(event);
		});
		expect(events).toEqual([
			{ kind: "message", message: update.message, chatId: 42, fromId: 7 },
		]);
	});

	it("awaits an async handler", async () => {
		const handler = vi.fn(async () => {});
		await dispatchUpdate(
			{ update_id: 2, poll_answer: { poll_id: "p", option_ids: [] } } as Update,
			handler,
		);
		expect(handler).toHaveBeenCalledWith({
			kind: "ignored",
			updateType: "poll_answer",
		});
	});
});

describe("fetchBytesFromUrl", () => {
	it("returns the response bytes", async () => {
		const fetchMock = vi.fn(
			async () => new Response(new Uint8Array([1, 2, 3])),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const bytes = await fetchBytesFromUrl("https://example/f");
			expect([...bytes]).toEqual([1, 2, 3]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("throws on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response("nope", { status: 404, statusText: "Not Found" }),
		);
		try {
			await expect(fetchBytesFromUrl("https://example/f")).rejects.toThrow(
				"404",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
