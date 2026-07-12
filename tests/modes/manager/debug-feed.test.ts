import { describe, expect, it } from "vitest";
import type { ManagerTurnLog } from "../../../src/modes/manager/controller";
import {
	buildManagerFeed,
	buildManagerNotice,
	telegramChatDeepLink,
} from "../../../src/modes/manager/debug-feed";

const NOW = "[Now: 2026-07-11 20:00 +05]";

function feed(
	log: ManagerTurnLog,
	extra: Partial<Parameters<typeof buildManagerFeed>[0]> = {},
) {
	return buildManagerFeed({
		log,
		subMode: "observer",
		nowLine: NOW,
		tools: [],
		...extra,
	}).toString();
}

describe("buildManagerFeed", () => {
	it("renders a reply turn: header, thinking in a details block, tools, quote", () => {
		const html = feed(
			{
				chatId: "42",
				contactName: "Alice",
				outcome: "reply",
				text: "Hello there!",
				category: "question",
				replyToMessageId: 7,
			},
			{
				thinking: "She asked a direct question, so I answer briefly.",
				tools: [{ name: "manager_reply", args: '{"text":"Hello there!"}' }],
			},
		);
		expect(html).toContain("Alice");
		expect(html).toContain("#42");
		expect(html).toContain("observer");
		expect(html).toContain("Replied");
		expect(html).toContain("question");
		// The reply target is named (the interlocutor), not a bare message id.
		expect(html).toContain("to Alice");
		expect(html).not.toContain("#7");
		// Thinking is folded into a collapsed <details> disclosure.
		expect(html).toContain("<details>");
		expect(html).toContain("Model thinking");
		expect(html).toContain("She asked a direct question");
		// Tool calls are listed.
		expect(html).toContain("manager_reply");
		// The delivered reply is quoted.
		expect(html).toContain("<blockquote>");
		expect(html).toContain("Hello there!");
		expect(html).toContain(NOW);
	});

	it("renders a silent turn with the reason in italics, no quote", () => {
		const html = feed({
			chatId: "9",
			contactName: "Bob",
			outcome: "silent",
			text: "Casual banter between friends.",
			category: "chatter",
		});
		expect(html).toContain("Stayed silent");
		expect(html).toContain("Casual banter");
		expect(html).toContain("<i>");
		expect(html).not.toContain("<blockquote>");
	});

	it("omits the thinking block when there is no reasoning", () => {
		const html = feed({ chatId: "1", contactName: "X", outcome: "silent" });
		expect(html).not.toContain("Model thinking");
	});

	it("shows name + @username/phone up top and folds ids into Contact", () => {
		const html = feed({
			chatId: "42",
			contactName: "Alice Smith",
			username: "alice",
			phone: "+7 700 000",
			userId: "5",
			languageCode: "en",
			isPremium: true,
			isBot: false,
			outcome: "reply",
			text: "hi",
		});
		// Visible: full name (bolded) with @username and phone in parentheses.
		expect(html).toContain("<b>Alice Smith</b> (@alice, +7 700 000)");
		// Folded Contact block carries the ids and flags.
		expect(html).toContain("<summary>ℹ️ Contact</summary>");
		expect(html).toContain("#42");
		expect(html).toContain("Premium: yes");
		expect(html).toContain("Bot: no");
	});

	it("truncates very long thinking and marks the cut", () => {
		const html = feed(
			{ chatId: "1", contactName: "X", outcome: "reply", text: "ok" },
			{ thinking: "z".repeat(5000) },
		);
		expect(html).toContain("[+");
		expect(html).toContain("chars]");
	});

	it("escapes HTML in model text so it cannot break the markup", () => {
		const html = feed({
			chatId: "1",
			contactName: "X",
			outcome: "reply",
			text: "1 < 2 & 3 > 0",
		});
		expect(html).toContain("&lt;");
		expect(html).toContain("&amp;");
		expect(html).not.toContain("1 < 2");
	});
});

describe("telegramChatDeepLink", () => {
	it("builds a tg:// link, optionally jumping to a message", () => {
		expect(telegramChatDeepLink("5")).toBe("tg://openmessage?user_id=5");
		expect(telegramChatDeepLink("5", 7)).toBe(
			"tg://openmessage?user_id=5&message_id=7",
		);
	});

	it("returns undefined without a numeric user id", () => {
		expect(telegramChatDeepLink(undefined)).toBeUndefined();
		expect(telegramChatDeepLink("")).toBeUndefined();
		expect(telegramChatDeepLink("abc")).toBeUndefined();
	});

	it("makes the chat id a tappable deep link in the feed when the user id is known", () => {
		const html = feed({
			chatId: "42",
			contactName: "Alice",
			outcome: "reply",
			text: "hi",
			userId: "5",
			replyToMessageId: 7,
		});
		// The ampersand is HTML-escaped inside the attribute (decodes back to & in
		// the client), which is correct HTML.
		expect(html).toContain(
			'href="tg://openmessage?user_id=5&amp;message_id=7"',
		);
	});

	it("keeps the raw chat id (no link) when the user id is unknown", () => {
		const html = feed({
			chatId: "42",
			contactName: "Alice",
			outcome: "silent",
		});
		expect(html).toContain("#42");
		expect(html).not.toContain("tg://openmessage");
	});
});

describe("buildManagerNotice", () => {
	it("renders a warning/error notice with its badge and message", () => {
		const warn = buildManagerNotice("warning", "rich fell back to plain", NOW);
		expect(warn.toString()).toContain("Warning");
		expect(warn.toString()).toContain("rich fell back to plain");
		expect(warn.toString()).toContain(NOW);

		const err = buildManagerNotice("error", "Telegram error: 429", NOW);
		expect(err.toString()).toContain("Error");
		expect(err.toString()).toContain("Telegram error: 429");
	});
});
