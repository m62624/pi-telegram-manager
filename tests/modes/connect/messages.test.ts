import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
	assistantReplyText,
	extractText,
	formatPiCommandList,
	lastAssistantReply,
	messageText,
	messageToTurnInput,
	parseSlashCommand,
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

describe("parseSlashCommand", () => {
	it("parses a bare command", () => {
		expect(parseSlashCommand("/clear")).toEqual({ name: "clear", arg: "" });
	});

	it("lowercases the name and strips a @botname suffix", () => {
		expect(parseSlashCommand("/Clear@MyBot")).toEqual({
			name: "clear",
			arg: "",
		});
	});

	it("captures a trailing argument", () => {
		expect(parseSlashCommand("/new some topic")).toEqual({
			name: "new",
			arg: "some topic",
		});
	});

	it("returns null for ordinary text and prose containing a slash", () => {
		expect(parseSlashCommand("hello")).toBeNull();
		expect(parseSlashCommand("path is a/b")).toBeNull();
		expect(parseSlashCommand("")).toBeNull();
	});
});

describe("formatPiCommandList", () => {
	it("lists commands sorted, slash-prefixed, with descriptions", () => {
		const out = formatPiCommandList([
			{ name: "telegram-connect", description: "Bind chat" },
			{ name: "planner-create", description: "New plan" },
			{ name: "bare" },
		]);
		expect(out).toContain("run these in the terminal");
		const lines = out.split("\n").slice(1);
		expect(lines).toEqual([
			"/bare",
			"/planner-create — New plan",
			"/telegram-connect — Bind chat",
		]);
	});

	it("handles an empty registry", () => {
		expect(formatPiCommandList([])).toBe("No Pi commands are registered.");
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

	it("excludes private reasoning parts but keeps text of any other type", () => {
		expect(
			extractText([
				{ type: "thinking", text: "secret reasoning" },
				{ type: "reasoning", text: "more reasoning" },
				{ type: "output_text", text: "visible reply" },
			]),
		).toBe("visible reply");
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

describe("lastAssistantReply", () => {
	it("skips a trailing empty assistant message and returns the real reply", () => {
		expect(
			lastAssistantReply([
				{ role: "user", content: "Привет!" },
				{ role: "assistant", content: "Привет! Чем могу помочь?" },
				{ role: "assistant", content: "" },
			]),
		).toBe("Привет! Чем могу помочь?");
	});

	it("returns null when no assistant message has text", () => {
		expect(lastAssistantReply([{ role: "user", content: "hi" }])).toBeNull();
		expect(lastAssistantReply([])).toBeNull();
	});
});
