import { describe, expect, it } from "vitest";
import {
	blockquote,
	bold,
	buildRichHtmlMessage,
	collapsibleCode,
	escapeHtml,
	heading,
	inlineCode,
	italic,
	link,
	list,
	mathBlock,
	preformatted,
	RichHtml,
	RichHtmlDocument,
	richHtmlToText,
	spoiler,
	subscript,
	superscript,
	table,
	thinking,
} from "../../src/telegram/rich-builder";

describe("escaping", () => {
	it("escapes the three sensitive characters", () => {
		expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
	});

	it("escapes plain text passed as content exactly once", () => {
		expect(bold("a < b").html).toBe("<b>a &lt; b</b>");
	});

	it("passes RichHtml content through without double-escaping", () => {
		const nested = bold(inlineCode("a < b"));
		expect(nested.html).toBe("<b><code>a &lt; b</code></b>");
	});

	it("RichHtml.of escapes strings and passes RichHtml through", () => {
		expect(RichHtml.of("x<y").html).toBe("x&lt;y");
		const raw = RichHtml.raw("<i>x</i>");
		expect(RichHtml.of(raw)).toBe(raw);
	});
});

describe("inline builders", () => {
	it("wraps spoiler, subscript, and superscript in the right tags", () => {
		expect(spoiler("s").html).toBe("<tg-spoiler>s</tg-spoiler>");
		expect(subscript("2").html).toBe("<sub>2</sub>");
		expect(superscript("n").html).toBe("<sup>n</sup>");
	});

	it("escapes the href attribute of a link", () => {
		expect(link("t", 'https://x/?a="1"&b=2').html).toBe(
			'<a href="https://x/?a=&quot;1&quot;&amp;b=2">t</a>',
		);
	});
});

describe("block builders", () => {
	it("emits a heading at the requested level with a default of 2", () => {
		expect(heading("Title").html).toBe("<h2>Title</h2>");
		expect(heading("Big", 1).html).toBe("<h1>Big</h1>");
	});

	it("tags a preformatted block with its language", () => {
		expect(preformatted("x < 1", "ts").html).toBe(
			'<pre><code class="language-ts">x &lt; 1</code></pre>',
		);
		expect(preformatted("plain").html).toBe("<pre>plain</pre>");
	});

	it("wraps a code diff in a collapsed details block with a line-count summary", () => {
		const html = collapsibleCode("- a\n+ b", { language: "diff" }).html;
		expect(html).toBe(
			'<details><summary>diff (2 lines)</summary><pre><code class="language-diff">- a\n+ b</code></pre></details>',
		);
	});

	it("honors an explicit summary and the open flag", () => {
		const html = collapsibleCode("x", { summary: "Show", open: true }).html;
		expect(html).toContain("<details open>");
		expect(html).toContain("<summary>Show</summary>");
	});

	it("renders a block quotation with an optional credit", () => {
		expect(blockquote(["hi"], "me").html).toBe(
			"<blockquote>hi<cite>me</cite></blockquote>",
		);
		expect(blockquote(["hi"]).html).toBe("<blockquote>hi</blockquote>");
	});

	it("renders a LaTeX block, escaping the source", () => {
		expect(mathBlock("a < b").html).toBe(
			"<tg-math-block>a &lt; b</tg-math-block>",
		);
	});
});

describe("list", () => {
	it("renders an unordered list", () => {
		expect(list(["a", "b"]).html).toBe("<ul><li>a</li><li>b</li></ul>");
	});

	it("renders an ordered list with a start offset", () => {
		expect(list(["a"], { ordered: true, start: 3 }).html).toBe(
			'<ol start="3"><li>a</li></ol>',
		);
	});

	it("renders checkbox items", () => {
		expect(
			list([
				{ text: "done", checked: true },
				{ text: "todo", checkbox: true },
			]).html,
		).toBe(
			'<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul>',
		);
	});
});

describe("table", () => {
	it("renders headers, alignment, spans, and table attributes", () => {
		const html = table(
			[
				[{ text: "H", header: true, align: "center" }],
				[{ text: "v", colspan: 2, valign: "top" }],
			],
			{ bordered: true, striped: true, caption: "Cap" },
		).html;
		expect(html).toBe(
			"<table bordered striped><caption>Cap</caption>" +
				'<tr><th align="center">H</th></tr>' +
				'<tr><td valign="top" colspan="2">v</td></tr></table>',
		);
	});

	it("renders an invisible cell when text is omitted", () => {
		expect(table([[{}]]).html).toBe("<table><tr><td></td></tr></table>");
	});
});

describe("RichHtmlDocument", () => {
	it("accumulates blocks and builds an html rich message", () => {
		const message = new RichHtmlDocument()
			.heading("Report")
			.paragraph("Body & tail")
			.collapsibleCode("- a\n+ b", { language: "diff" })
			.build();
		expect(message.html).toBe(
			"<h2>Report</h2>\n<p>Body &amp; tail</p>\n" +
				'<details><summary>diff (2 lines)</summary><pre><code class="language-diff">- a\n+ b</code></pre></details>',
		);
		expect(message.markdown).toBeUndefined();
	});

	it("reports emptiness", () => {
		const doc = new RichHtmlDocument();
		expect(doc.isEmpty()).toBe(true);
		doc.paragraph("x");
		expect(doc.isEmpty()).toBe(false);
	});
});

describe("thinking", () => {
	it("wraps escaped text in the animated placeholder tag", () => {
		expect(thinking("bash — npm test").html).toBe(
			"<tg-thinking>bash — npm test</tg-thinking>",
		);
		expect(thinking("<script>").html).toBe(
			"<tg-thinking>&lt;script&gt;</tg-thinking>",
		);
	});

	it("nests built markup without double-escaping it", () => {
		expect(thinking(inlineCode("npm test")).html).toBe(
			"<tg-thinking><code>npm test</code></tg-thinking>",
		);
	});
});

describe("richHtmlToText", () => {
	/**
	 * The chain this function replaced. It is kept here as the ORACLE: the rewrite was
	 * made to drop a flagged pattern (CodeQL js/incomplete-multi-character-sanitization
	 * — a strip pass followed by a decode pass that can hand back what the strip took
	 * out), not to change what anyone reads. So the new scanner is checked against the
	 * old chain on everything the bot can actually send.
	 */
	const legacy = (html: string): string =>
		html
			.replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");

	it("matches the old chain on our own markup, tags and all", () => {
		const ours = [
			bold("a").html,
			RichHtml.join([bold("a"), RichHtml.text(" & "), italic("b")]).html,
			preformatted("x < 1", "ts").html,
			collapsibleCode("- a\n+ b", { language: "diff" }).html,
			list([{ text: "done", checked: true }, "todo"]).html,
			table([[{ text: "H", header: true }], [{ text: "v" }]], {
				caption: "Cap",
			}).html,
			link("t", 'https://x/?a="1"&b=2').html,
			thinking(inlineCode("npm test")).html,
			mathBlock("a < b").html,
			blockquote(["hi"], "me").html,
			new RichHtmlDocument().heading("R").paragraph("Body & tail").toHtml(),
		];
		for (const html of ours) expect(richHtmlToText(html)).toBe(legacy(html));
	});

	it("matches the old chain on malformed and adversarial html", () => {
		const nasty = [
			// A tag split by another tag: neither implementation reassembles it.
			"<scrip<script>t>alert(1)</script>",
			// An attribute carrying a ">" — the tag ends at the FIRST ">", for both.
			'<a href="a>b">t</a>',
			// A "<" opened and never closed.
			"<b>unterminated",
			// Bare comparison operators in text (only reachable from hand-written html).
			"2 < 3 and 4 > 3",
			"a < b",
			"text with > alone",
			// Double-escaped: one level comes off, and only one.
			"&amp;lt;",
			// An entity we do not know stays exactly as it is.
			"a &unknown; b",
			"&; &",
			"",
			"<b></b>",
		];
		for (const html of nasty) expect(richHtmlToText(html)).toBe(legacy(html));
	});

	it("decodes escaped markup back into text — as the old chain did", () => {
		// Both produce "<script>…" here, and that is CORRECT: the result is the plain
		// TEXT of the message, sent with no parse_mode, so these are characters the
		// author typed, not markup anyone parses. What the single pass guarantees is
		// that this "<" is only ever written to the output — never scanned again, so it
		// can never re-open a tag the way a second replace pass could.
		const html = "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>";
		expect(richHtmlToText(html)).toBe("<script>alert(1)</script>");
		expect(richHtmlToText(html)).toBe(legacy(html));
	});

	it("drops tags and decodes the entities we emit", () => {
		expect(richHtmlToText("<b>a</b> &amp; <i>b</i>")).toBe("a & b");
		expect(richHtmlToText("<pre><code>x &lt; 1</code></pre>")).toBe("x < 1");
		expect(richHtmlToText('<a href="https://x/?a=&quot;1&quot;">t</a>')).toBe(
			"t",
		);
	});

	it("also decodes &quot;, which the old chain left raw", () => {
		// The one deliberate difference. `&quot;` is only ever emitted INSIDE an
		// attribute (escapeAttr), and an attribute leaves with its tag — so this is
		// unreachable for markup we build, and can only help with markup we do not.
		expect(richHtmlToText("she said &quot;hi&quot;")).toBe('she said "hi"');
		expect(legacy("she said &quot;hi&quot;")).toBe("she said &quot;hi&quot;");
	});

	it("round-trips whatever escapeHtml escaped", () => {
		const source = 'a & b < c > d "e"';
		expect(richHtmlToText(escapeHtml(source))).toBe(source);
	});
});

describe("buildRichHtmlMessage", () => {
	it("escapes a plain string and wraps built html verbatim", () => {
		expect(buildRichHtmlMessage("a<b")).toEqual({ html: "a&lt;b" });
		expect(buildRichHtmlMessage(heading("Hi"))).toEqual({
			html: "<h2>Hi</h2>",
		});
	});
});
