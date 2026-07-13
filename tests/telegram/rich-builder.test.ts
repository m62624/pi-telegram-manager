import { describe, expect, it } from "vitest";
import {
	blockquote,
	bold,
	buildRichHtmlMessage,
	collapsibleCode,
	escapeHtml,
	heading,
	inlineCode,
	link,
	list,
	mathBlock,
	preformatted,
	RichHtml,
	RichHtmlDocument,
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

describe("buildRichHtmlMessage", () => {
	it("escapes a plain string and wraps built html verbatim", () => {
		expect(buildRichHtmlMessage("a<b")).toEqual({ html: "a&lt;b" });
		expect(buildRichHtmlMessage(heading("Hi"))).toEqual({
			html: "<h2>Hi</h2>",
		});
	});
});
