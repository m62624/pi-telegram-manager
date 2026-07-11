import { describe, expect, it } from "vitest";
import type { ManagerTurnLog } from "../../../src/modes/manager/controller";
import {
	buildManagerFeed,
	buildManagerNotice,
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
		expect(html).not.toContain("<details>");
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
