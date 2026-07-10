import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import { buildContextLines } from "../../src/core/turns";
import { extractMessageContext } from "../../src/telegram/message-context";

const base = {
	message_id: 1,
	date: 0,
	chat: { id: 1, type: "private", first_name: "A" },
} as const;

function msg(extra: Record<string, unknown>): Message {
	return { ...base, ...extra } as Message;
}

describe("extractMessageContext", () => {
	it("describes a forward from a user", () => {
		const ctx = extractMessageContext(
			msg({
				text: "hi",
				forward_origin: {
					type: "user",
					date: 0,
					sender_user: { id: 5, is_bot: false, first_name: "Bob" },
				},
			}),
		);
		expect(ctx.forwardedFrom).toBe("Bob");
	});

	it("describes a forward from a channel with a title", () => {
		const ctx = extractMessageContext(
			msg({
				text: "post",
				forward_origin: {
					type: "channel",
					date: 0,
					chat: { id: -100, type: "channel", title: "News" },
					message_id: 9,
				},
			}),
		);
		expect(ctx.forwardedFrom).toBe("channel «News»");
	});

	it("marks a hidden-user forward", () => {
		const ctx = extractMessageContext(
			msg({
				text: "x",
				forward_origin: {
					type: "hidden_user",
					date: 0,
					sender_user_name: "Someone",
				},
			}),
		);
		expect(ctx.forwardedFrom).toBe("Someone (hidden)");
	});

	it("captures a same-chat reply with author and text", () => {
		const ctx = extractMessageContext(
			msg({
				text: "yes",
				reply_to_message: {
					message_id: 2,
					date: 0,
					chat: base.chat,
					from: { id: 7, is_bot: false, first_name: "Carol" },
					text: "are you coming?",
				},
			}),
		);
		expect(ctx.reply).toEqual({ author: "Carol", text: "are you coming?" });
	});

	it("falls back to a media descriptor for a reply without text", () => {
		const ctx = extractMessageContext(
			msg({
				text: "nice",
				reply_to_message: {
					message_id: 2,
					date: 0,
					chat: base.chat,
					from: { id: 7, is_bot: false, first_name: "Carol" },
					photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
				},
			}),
		);
		expect(ctx.reply?.text).toBe("<photo>");
	});

	it("captures a partial quote", () => {
		const ctx = extractMessageContext(
			msg({
				text: "agreed",
				quote: { text: "the second clause", position: 3 },
			}),
		);
		expect(ctx.quote).toBe("the second clause");
	});

	it("describes a cross-chat (external) reply", () => {
		const ctx = extractMessageContext(
			msg({
				text: "look",
				external_reply: {
					origin: {
						type: "channel",
						date: 0,
						chat: { id: -100, type: "channel", title: "News" },
						message_id: 3,
					},
					photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
				},
			}),
		);
		expect(ctx.externalReply).toBe("a photo from channel «News»");
	});

	it("flags a reply to a story", () => {
		const ctx = extractMessageContext(
			msg({ text: "cool", reply_to_story: { chat: base.chat, id: 1 } }),
		);
		expect(ctx.replyToStory).toBe(true);
	});
});

describe("buildContextLines (integration with the extractor)", () => {
	it("renders forward + reply + quote in a stable order", () => {
		const lines = buildContextLines(
			extractMessageContext(
				msg({
					text: "sure",
					forward_origin: {
						type: "user",
						date: 0,
						sender_user: { id: 5, is_bot: false, first_name: "Bob" },
					},
					reply_to_message: {
						message_id: 2,
						date: 0,
						chat: base.chat,
						from: { id: 7, is_bot: false, first_name: "Carol" },
						text: "the whole thing",
					},
					quote: { text: "the whole", position: 0 },
				}),
			),
		);
		expect(lines).toEqual([
			"[forwarded from: Bob]",
			'[reply to Carol]: "the whole thing"',
			'[quoting]: "the whole"',
		]);
	});
});
