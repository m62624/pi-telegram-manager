import { describe, expect, it } from "vitest";
import {
	buildAttachmentErrorsLine,
	buildAttachmentsLine,
	buildHeader,
	buildPromptTurn,
	buildReplyLine,
	buildSavedFilesLine,
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

	it("stamps the arrival time into the header, last", () => {
		// The clock belongs to the message. It used to be a context message of its own,
		// re-appended before every call to the model — which the model read as a turn
		// and answered ("a background tick, I am not replying"), out loud, into the chat.
		expect(
			buildHeader({
				senderName: "Alice",
				receivedAt: "Mon 2026-07-13 10:33 +05:00",
			}),
		).toBe("[telegram|from:Alice|at:Mon 2026-07-13 10:33 +05:00]");
	});

	it("omits the stamp when the arrival time is unknown", () => {
		expect(buildHeader({ senderName: "Alice" })).toBe("[telegram|from:Alice]");
	});
});

describe("buildReplyLine", () => {
	it("names the message being answered, and whose words the quote is", () => {
		expect(buildReplyLine({ author: "Bob", text: "earlier" })).toBe(
			'[answering an earlier message by Bob, which said: "earlier"]',
		);
	});

	it('never writes the quoted party as a speaker (`Name: "text"`)', () => {
		// The old shape was `[reply to Bob]: "earlier"`, which a small model read as
		// BOB talking — the exact confusion that made the manager answer the owner's
		// own reply as if the person they were answering had asked it.
		expect(buildReplyLine({ author: "Bob", text: "earlier" })).not.toContain(
			'Bob]: "',
		);
	});

	it("omits the author when unknown", () => {
		expect(buildReplyLine({ text: "earlier" })).toBe(
			'[answering an earlier message, which said: "earlier"]',
		);
	});

	it("truncates a long quote with an ellipsis", () => {
		const long = "x".repeat(REPLY_QUOTE_MAX + 50);
		const line = buildReplyLine({ text: long });
		expect(line).toBe(
			`[answering an earlier message, which said: "${"x".repeat(REPLY_QUOTE_MAX)}…"]`,
		);
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
			'[telegram|from:Alice|chat:General]\n[answering an earlier message by Bob, which said: "before"]\n[attachments: photo]\n\nhello there',
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

	it("lists saved files with their absolute paths and errors", () => {
		const turn = buildPromptTurn({
			text: "here you go",
			savedFiles: [
				{
					path: "/work/report.pdf",
					kind: "document",
					size: "1.2 MB",
					mimeType: "application/pdf",
				},
			],
			attachmentErrors: ["huge.zip: too large"],
		});
		expect(turn).toContain(
			"[saved files: /work/report.pdf (1.2 MB, application/pdf)]",
		);
		expect(turn).toContain("[attachment errors: huge.zip: too large]");
		expect(turn.endsWith("here you go")).toBe(true);
	});
});

describe("buildSavedFilesLine", () => {
	it("is empty when there are no saved files", () => {
		expect(buildSavedFilesLine(undefined)).toBe("");
		expect(buildSavedFilesLine([])).toBe("");
	});

	it("joins multiple files with a semicolon", () => {
		expect(
			buildSavedFilesLine([
				{ path: "/a.txt", kind: "document" },
				{ path: "/b.bin", kind: "document", size: "2 KB" },
			]),
		).toBe("[saved files: /a.txt; /b.bin (2 KB)]");
	});
});

describe("buildAttachmentErrorsLine", () => {
	it("is empty without errors and lists them otherwise", () => {
		expect(buildAttachmentErrorsLine([])).toBe("");
		expect(buildAttachmentErrorsLine(["x: boom", "y: nope"])).toBe(
			"[attachment errors: x: boom; y: nope]",
		);
	});
});
