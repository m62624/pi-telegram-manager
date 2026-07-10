import { describe, expect, it } from "vitest";
import {
	buildAttachmentsLine,
	buildHeader,
	buildPromptTurn,
	buildReplyLine,
	REPLY_QUOTE_MAX,
} from "../../src/core/turns";

describe("buildHeader", () => {
	it("includes only the attributes present", () => {
		expect(buildHeader({ senderName: "Alice", chatTitle: "General" })).toBe(
			"[telegram|from:Alice|chat:General]",
		);
		expect(buildHeader({ senderName: "Alice" })).toBe("[telegram|from:Alice]");
		expect(buildHeader({})).toBe("[telegram]");
	});

	it("sanitizes framing characters out of attribute values", () => {
		expect(buildHeader({ senderName: "a|b]c\nd" })).toBe(
			"[telegram|from:a b c d]",
		);
	});
});

describe("buildReplyLine", () => {
	it("quotes the replied-to text with its author", () => {
		expect(buildReplyLine({ author: "Bob", text: "earlier" })).toBe(
			'[reply to Bob]: "earlier"',
		);
	});

	it("omits the author when unknown", () => {
		expect(buildReplyLine({ text: "earlier" })).toBe('[reply]: "earlier"');
	});

	it("truncates a long quote with an ellipsis", () => {
		const long = "x".repeat(REPLY_QUOTE_MAX + 50);
		const line = buildReplyLine({ text: long });
		expect(line).toBe(`[reply]: "${"x".repeat(REPLY_QUOTE_MAX)}…"`);
	});

	it("is empty without a reply", () => {
		expect(buildReplyLine(undefined)).toBe("");
	});
});

describe("buildAttachmentsLine", () => {
	it("lists kinds, quoting file names when present", () => {
		expect(
			buildAttachmentsLine([
				{ kind: "photo" },
				{ kind: "document", fileName: "report.pdf" },
			]),
		).toBe('[attachments: photo, document "report.pdf"]');
	});

	it("is empty for no attachments", () => {
		expect(buildAttachmentsLine([])).toBe("");
		expect(buildAttachmentsLine(undefined)).toBe("");
	});
});

describe("buildPromptTurn", () => {
	it("stacks header lines, a blank line, then the body", () => {
		const turn = buildPromptTurn({
			senderName: "Alice",
			chatTitle: "General",
			reply: { author: "Bob", text: "before" },
			attachments: [{ kind: "photo" }],
			text: "hello there",
		});
		expect(turn).toBe(
			'[telegram|from:Alice|chat:General]\n[reply to Bob]: "before"\n[attachments: photo]\n\nhello there',
		);
	});

	it("emits just the header when there is no body", () => {
		expect(buildPromptTurn({ senderName: "Alice" })).toBe(
			"[telegram|from:Alice]",
		);
	});

	it("trims the body", () => {
		expect(buildPromptTurn({ text: "  hi  " })).toBe("[telegram]\n\nhi");
	});
});
