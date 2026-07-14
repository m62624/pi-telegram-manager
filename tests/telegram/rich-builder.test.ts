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
	 * What the OLD implementation returned, input by input.
	 *
	 * The rewrite existed to drop a flagged shape (CodeQL
	 * js/incomplete-multi-character-sanitization: strip the tags, then decode the
	 * entities, and the decode hands back what the strip removed) — NOT to change what
	 * anyone reads. So the guarantee that has to be pinned is "same output as before",
	 * and it is pinned the only way that cannot rot: as the outputs themselves.
	 *
	 * They were captured by running the pre-change function (`git show 302778e^ --
	 * src/telegram/outbound.ts`) over these exact inputs. The chain itself is
	 * deliberately NOT reproduced here — a test that re-implements it would carry the
	 * very pattern the change removed, and one that called the new function instead
	 * would be comparing it with itself and proving nothing at all.
	 */
	const BEFORE_THE_REWRITE: readonly (readonly [string, string])[] = [
		// Our own builders' markup — everything the bot can actually send.
		["<b>a</b> &amp; <i>b</i>", "a & b"],
		['<pre><code class="language-ts">x &lt; 1</code></pre>', "x < 1"],
		[
			'<details><summary>diff (2 lines)</summary><pre><code class="language-diff">- a\n+ b</code></pre></details>',
			"diff (2 lines)- a\n+ b",
		],
		[
			'<ul><li><input type="checkbox" checked>done</li><li>todo</li></ul>',
			"donetodo",
		],
		[
			"<table><caption>Cap</caption><tr><th>H</th></tr><tr><td>v</td></tr></table>",
			"CapHv",
		],
		['<a href="https://x/?a=&quot;1&quot;&amp;b=2">t</a>', "t"],
		["<tg-thinking><code>npm test</code></tg-thinking>", "npm test"],
		["<tg-math-block>a &lt; b</tg-math-block>", "a < b"],
		["<blockquote>hi<cite>me</cite></blockquote>", "hime"],
		["<h2>R</h2>\n<p>Body &amp; tail</p>", "R\nBody & tail"],
		// Malformed and adversarial html.
		// A tag split by another tag: neither implementation reassembles it.
		["<scrip<script>t>alert(1)</script>", "t>alert(1)"],
		// An attribute carrying a ">" — the tag ends at the FIRST ">", for both.
		['<a href="a>b">t</a>', 'b">t'],
		// A "<" opened and never closed.
		["<b>unterminated", "unterminated"],
		// Bare comparison operators (only reachable from hand-written html): the old
		// chain ate everything between them, and so, faithfully, does the new one.
		["2 < 3 and 4 > 3", "2  3"],
		["a < b", "a < b"],
		["text with > alone", "text with > alone"],
		// Double-escaped: one level comes off, and only one.
		["&amp;lt;", "&lt;"],
		// An entity we do not know stays exactly as it is.
		["a &unknown; b", "a &unknown; b"],
		["&; &", "&; &"],
		["", ""],
		["<b></b>", ""],
		// Escaped markup decodes back into text. That is CORRECT and it is what the old
		// chain did: the result is the plain TEXT of the message, sent with no
		// parse_mode, so these are characters the author typed, not markup anyone
		// parses. What the single pass guarantees is that this "<" is only ever WRITTEN
		// to the output — never scanned again — so it cannot re-open a tag the way a
		// second replace pass could.
		[
			"<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
			"<script>alert(1)</script>",
		],
	];

	it("returns exactly what the old implementation returned", () => {
		for (const [html, before] of BEFORE_THE_REWRITE) {
			expect(richHtmlToText(html)).toBe(before);
		}
	});

	it("covers the markup our own builders emit", () => {
		// The corpus above is hand-written, so it can drift from the builders. This ties
		// it back to them: every builder's real output must still read as its text.
		expect(richHtmlToText(bold("a").html)).toBe("a");
		expect(
			richHtmlToText(
				RichHtml.join([bold("a"), RichHtml.text(" & "), italic("b")]).html,
			),
		).toBe("a & b");
		expect(richHtmlToText(preformatted("x < 1", "ts").html)).toBe("x < 1");
		expect(
			richHtmlToText(collapsibleCode("- a\n+ b", { language: "diff" }).html),
		).toBe("diff (2 lines)- a\n+ b");
		expect(
			richHtmlToText(list([{ text: "done", checked: true }, "todo"]).html),
		).toBe("donetodo");
		expect(
			richHtmlToText(
				table([[{ text: "H", header: true }], [{ text: "v" }]], {
					caption: "Cap",
				}).html,
			),
		).toBe("CapHv");
		expect(richHtmlToText(link("t", 'https://x/?a="1"&b=2').html)).toBe("t");
		expect(richHtmlToText(thinking(inlineCode("npm test")).html)).toBe(
			"npm test",
		);
		expect(richHtmlToText(mathBlock("a < b").html)).toBe("a < b");
		expect(richHtmlToText(blockquote(["hi"], "me").html)).toBe("hime");
		expect(
			richHtmlToText(
				new RichHtmlDocument().heading("R").paragraph("Body & tail").toHtml(),
			),
		).toBe("R\nBody & tail");
	});

	it("drops tags and decodes the entities we emit", () => {
		expect(richHtmlToText("<b>a</b> &amp; <i>b</i>")).toBe("a & b");
		expect(richHtmlToText("<pre><code>x &lt; 1</code></pre>")).toBe("x < 1");
		expect(richHtmlToText('<a href="https://x/?a=&quot;1&quot;">t</a>')).toBe(
			"t",
		);
	});

	it("also decodes &quot;, which the old chain left raw", () => {
		// The one deliberate difference (the old chain knew only &lt; &gt; &amp;, so it
		// let "&quot;" through as those six literal characters). `&quot;` is only ever
		// emitted INSIDE an attribute (escapeAttr), and an attribute leaves with its
		// tag — so this is unreachable for markup we build, and can only help with
		// markup we do not.
		expect(richHtmlToText("she said &quot;hi&quot;")).toBe('she said "hi"');
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
