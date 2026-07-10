import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
	assistantReplyText,
	extractText,
	messageText,
	messageToTurnInput,
	senderDisplayName,
} from "../../../src/modes/connect/messages";

function message(overrides: Partial<Message>): Message {
	return {
		message_id: 1,
		date: 0,
		chat: { id: 1, type: "private", first_name: "A" },
		...overrides,
	} as Message;
}

describe("senderDisplayName", () => {
	it("prefers the full name", () => {
		expect(
			senderDisplayName({
				id: 1,
				is_bot: false,
				first_name: "Ada",
				last_name: "Lovelace",
			}),
		).toBe("Ada Lovelace");
	});

	it("falls back to @username, then undefined", () => {
		expect(
			senderDisplayName({
				id: 1,
				is_bot: false,
				first_name: "",
				username: "ada",
			}),
		).toBe("@ada");
		expect(senderDisplayName(undefined)).toBeUndefined();
	});
});

describe("messageText", () => {
	it("uses the body or a media caption", () => {
		expect(messageText(message({ text: "hi" }))).toBe("hi");
		expect(messageText(message({ caption: "cap" }))).toBe("cap");
		expect(messageText(message({}))).toBe("");
	});
});

describe("messageToTurnInput", () => {
	it("maps sender, reply, and attachments", () => {
		const input = messageToTurnInput(
			message({
				caption: "see photo",
				from: { id: 7, is_bot: false, first_name: "Bob" },
				photo: [
					{
						file_id: "p",
						file_unique_id: "p",
						width: 100,
						height: 100,
						file_size: 10,
					},
				],
				reply_to_message: message({
					text: "earlier",
					from: { id: 8, is_bot: false, first_name: "Cara" },
				}),
			}),
		);
		expect(input).toEqual({
			text: "see photo",
			senderName: "Bob",
			reply: { author: "Cara", text: "earlier" },
			attachments: [
				{ kind: "photo", fileName: undefined, mimeType: undefined },
			],
		});
	});

	it("leaves reply and attachments undefined when absent", () => {
		const input = messageToTurnInput(
			message({
				text: "plain",
				from: { id: 7, is_bot: false, first_name: "Bob" },
			}),
		);
		expect(input.reply).toBeUndefined();
		expect(input.attachments).toBeUndefined();
	});
});

describe("extractText / assistantReplyText", () => {
	it("extracts text from string or content parts", () => {
		expect(extractText("hello")).toBe("hello");
		expect(
			extractText([
				{ type: "text", text: "a" },
				{ type: "image" },
				{ type: "text", text: "b" },
			]),
		).toBe("ab");
	});

	it("returns assistant reply text and ignores non-assistant messages", () => {
		expect(assistantReplyText({ role: "assistant", content: "  hi  " })).toBe(
			"hi",
		);
		expect(assistantReplyText({ role: "user", content: "hi" })).toBeNull();
		expect(
			assistantReplyText({ role: "assistant", content: "   " }),
		).toBeNull();
	});
});
