import { describe, expect, it } from "vitest";
import {
	normalizeRichMarkdown,
	RICH_MESSAGE_MAX_CHARS,
	splitRichMarkdown,
	toRichMarkdownMessages,
} from "../../src/telegram/markdown";

describe("normalizeRichMarkdown", () => {
	it("rewrites LaTeX delimiters to Telegram's dollar forms", () => {
		expect(normalizeRichMarkdown("before \\[ E = mc^2 \\] after")).toBe(
			"before $$ E = mc^2 $$ after",
		);
		expect(normalizeRichMarkdown("inline \\( x^2 \\) end")).toBe(
			"inline $ x^2 $ end",
		);
	});

	it("handles multi-line display math", () => {
		expect(normalizeRichMarkdown("\\[\na + b\n\\]")).toBe("$$\na + b\n$$");
	});

	it("leaves LaTeX delimiters inside fenced code untouched", () => {
		const input = "```\n\\[ not math \\]\n```";
		expect(normalizeRichMarkdown(input)).toBe(input);
	});

	it("leaves LaTeX delimiters inside inline code untouched", () => {
		const input = "text `\\( keep \\)` more";
		expect(normalizeRichMarkdown(input)).toBe(input);
	});

	it("normalizes CRLF to LF and is idempotent", () => {
		const once = normalizeRichMarkdown("a\r\nb\\(x\\)");
		expect(once).toBe("a\nb$x$");
		expect(normalizeRichMarkdown(once)).toBe(once);
	});

	it("keeps a fenced block with a language and $ inside it verbatim", () => {
		const input = "```bash\necho $HOME \\( \\)\n```";
		expect(normalizeRichMarkdown(input)).toBe(input);
	});
});

describe("splitRichMarkdown", () => {
	it("returns the input unchanged when within the limit", () => {
		expect(splitRichMarkdown("short", 100)).toEqual(["short"]);
	});

	it("never exceeds the limit and only cuts on line boundaries", () => {
		const lines = Array.from(
			{ length: 40 },
			(_, i) => `line-${i}-padding-text`,
		);
		const text = lines.join("\n");
		const chunks = splitRichMarkdown(text, 60);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(60);
		}
		// Rejoining loses nothing except the boundary newlines we split on.
		expect(chunks.join("\n")).toBe(text);
	});

	it("closes and reopens a fenced block that straddles a cut", () => {
		const code = Array.from({ length: 20 }, (_, i) => `code line ${i}`).join(
			"\n",
		);
		const text = `intro paragraph\n\n\`\`\`python\n${code}\n\`\`\``;
		const chunks = splitRichMarkdown(text, 80);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// Every chunk must have a balanced number of fence lines.
			const fences = chunk
				.split("\n")
				.filter((line) => /^```/.test(line)).length;
			expect(fences % 2).toBe(0);
		}
		// The reopened fence keeps the language.
		expect(chunks.slice(1).some((chunk) => chunk.startsWith("```python"))).toBe(
			true,
		);
	});

	it("hard-splits a single line longer than the limit", () => {
		const chunks = splitRichMarkdown("x".repeat(25), 10);
		expect(chunks).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
	});

	it("rejects a non-positive limit", () => {
		expect(() => splitRichMarkdown("a", 0)).toThrow(RangeError);
	});
});

describe("toRichMarkdownMessages", () => {
	it("normalizes then wraps each chunk as an InputRichMessage", () => {
		const messages = toRichMarkdownMessages("value \\( x \\)");
		expect(messages).toEqual([{ markdown: "value $ x $" }]);
	});

	it("produces multiple rich messages past the limit", () => {
		const big = Array.from(
			{ length: 5000 },
			(_, i) => `paragraph number ${i}`,
		).join("\n\n");
		const messages = toRichMarkdownMessages(big);
		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) {
			expect(message.markdown).toBeDefined();
			expect((message.markdown ?? "").length).toBeLessThanOrEqual(
				RICH_MESSAGE_MAX_CHARS,
			);
		}
	});
});
