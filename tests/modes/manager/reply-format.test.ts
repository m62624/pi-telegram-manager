import { describe, expect, it } from "vitest";
import { BOT_MARKER, hasBotMarker } from "../../../src/modes/manager/identity";
import { formatManagerReplyHtmlChunks } from "../../../src/modes/manager/reply-format";

describe("formatManagerReplyHtmlChunks", () => {
	it("wraps the labeler in a blockquote and tags each chunk with the bot marker", () => {
		const [chunk] = formatManagerReplyHtmlChunks(
			"Hello there!",
			"LLM agent 🤖:",
		);
		expect(chunk).toContain("<blockquote>LLM agent 🤖:</blockquote>");
		expect(chunk).toContain("Hello there!");
		expect(hasBotMarker(chunk)).toBe(true);
	});

	it("escapes HTML in the body and the labeler so parse_mode cannot break", () => {
		const [chunk] = formatManagerReplyHtmlChunks("1 < 2 & ok", "<b>x</b>:");
		expect(chunk).toContain("1 &lt; 2 &amp; ok");
		expect(chunk).toContain("&lt;b&gt;x&lt;/b&gt;:");
	});

	it("omits the labeler when none is configured", () => {
		const [chunk] = formatManagerReplyHtmlChunks("hi", undefined);
		expect(chunk).not.toContain("<blockquote>");
		expect(chunk).toBe(`hi${BOT_MARKER}`);
	});

	it("renders the model's Markdown body as Telegram HTML, not raw", () => {
		const [chunk] = formatManagerReplyHtmlChunks(
			"Here is **bold**, a `code` span, and:\n- one\n- two",
			undefined,
		);
		expect(chunk).toContain("<b>bold</b>");
		expect(chunk).toContain("<code>code</code>");
		expect(chunk).toContain("• one");
		// The raw Markdown punctuation must not reach the interlocutor.
		expect(chunk).not.toContain("**bold**");
	});

	it("adds the rule line as a second blockquote line when given", () => {
		const [chunk] = formatManagerReplyHtmlChunks("hi", "LLM:", "────────");
		expect(chunk).toContain("<blockquote>LLM:\n────────</blockquote>");
	});

	it("keeps just the label line when the rule is empty", () => {
		const [chunk] = formatManagerReplyHtmlChunks("hi", "LLM:", "");
		expect(chunk).toContain("<blockquote>LLM:</blockquote>");
	});

	it("drops the whole banner (rule included) when the labeler is empty", () => {
		const [chunk] = formatManagerReplyHtmlChunks("hi", "", "────────");
		expect(chunk).not.toContain("<blockquote>");
		expect(chunk).toBe(`hi${BOT_MARKER}`);
	});

	it("sends code to a person as highlightable code", () => {
		// The manager talks to strangers over a business connection, which takes classic
		// HTML — so the fence has to survive into `class="language-…"` or the code lands
		// grey. Telegram has no `rs`, so the tag is corrected on the way out.
		const [chunk] = formatManagerReplyHtmlChunks(
			"Here:\n\n```rs\nfn main() {}\n```",
		);
		expect(chunk).toContain('<pre><code class="language-rust">');
		expect(chunk).toContain("fn main() {}");
	});

	it("leaves a language Telegram already knows exactly as written", () => {
		const [chunk] = formatManagerReplyHtmlChunks("```bash\necho hi\n```");
		expect(chunk).toContain('<pre><code class="language-bash">');
	});

	it("puts the labeler only on the first chunk of a long reply", () => {
		const long = Array.from({ length: 400 }, (_, i) => `line number ${i}`).join(
			"\n",
		);
		const chunks = formatManagerReplyHtmlChunks(long, "L:");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toContain("<blockquote>L:</blockquote>");
		for (const chunk of chunks.slice(1)) {
			expect(chunk).not.toContain("<blockquote>");
			expect(hasBotMarker(chunk)).toBe(true);
		}
	});
});
