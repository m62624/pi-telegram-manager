import type { Update } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_ALLOWED_UPDATES,
	dispatchUpdate,
	fetchBytesFromUrl,
	fileBaseUrl,
	TelegramClient,
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

describe("TelegramClient update de-duplication", () => {
	const message = {
		message_id: 1,
		date: 0,
		chat: { id: 42, type: "private", first_name: "A" },
		from: { id: 7, is_bot: false, first_name: "A" },
		text: "hi",
	};

	function clientWith(updateCursor?: {
		claim: (id: number) => Promise<boolean>;
	}) {
		const events: TelegramEvent[] = [];
		const client = new TelegramClient({
			token: "123:ABC",
			onEvent: (event) => {
				events.push(event);
			},
			updateCursor,
		});
		// Avoid a getMe network call: handleUpdate builds a Context from botInfo.
		client.bot.botInfo = {
			id: 1,
			is_bot: true,
			first_name: "Bot",
			username: "bot",
			can_join_groups: true,
			can_read_all_group_messages: false,
			supports_inline_queries: false,
			can_connect_to_business: true,
			has_main_web_app: false,
		};
		return { client, events };
	}

	it("dispatches a fresh update but skips a redelivery after a restart", async () => {
		const seen = new Set<number>();
		const { client, events } = clientWith({
			claim: async (id) => {
				if (seen.has(id)) return false;
				seen.add(id);
				return true;
			},
		});
		const update = { update_id: 7, message } as Update;
		await client.bot.handleUpdate(update);
		// The same update, redelivered because its handler never let the offset
		// advance (a shutdown). It must not reach the handler a second time.
		await client.bot.handleUpdate(update);
		expect(events).toHaveLength(1);
	});

	it("dispatches every update when no cursor is configured", async () => {
		const { client, events } = clientWith();
		await client.bot.handleUpdate({ update_id: 7, message } as Update);
		await client.bot.handleUpdate({ update_id: 7, message } as Update);
		expect(events).toHaveLength(2);
	});
});

describe("TelegramClient.sendDocument", () => {
	function clientWithSpy() {
		const client = new TelegramClient({
			token: "123:ABC",
			onEvent: () => {},
		});
		const sendDocument = vi
			.spyOn(client.bot.api, "sendDocument")
			.mockResolvedValue({} as never);
		return { client, sendDocument };
	}

	it("posts the file into the given topic", async () => {
		const { client, sendDocument } = clientWithSpy();
		await client.sendDocument({
			chatId: 42,
			threadId: 7,
			url: "https://example/f.png",
			caption: "here",
		});
		expect(sendDocument).toHaveBeenCalledWith(42, "https://example/f.png", {
			caption: "here",
			message_thread_id: 7,
		});
	});

	it("omits the thread id when there is no topic", async () => {
		const { client, sendDocument } = clientWithSpy();
		await client.sendDocument({ chatId: 42, url: "https://example/f.png" });
		expect(sendDocument).toHaveBeenCalledWith(42, "https://example/f.png", {});
	});

	it("rejects a call with neither a path nor a url", async () => {
		const { client } = clientWithSpy();
		await expect(client.sendDocument({ chatId: 42 })).rejects.toThrow(
			"requires a local path or a url",
		);
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
