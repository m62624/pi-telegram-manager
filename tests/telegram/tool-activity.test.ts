import { describe, expect, it } from "vitest";
import {
	defaultDescribeArgs,
	formatToolArgs,
	toolActivityHtml,
	toolActivityMessage,
} from "../../src/telegram/tool-activity";

describe("formatToolArgs", () => {
	it("pretty-prints an object as JSON", () => {
		expect(formatToolArgs({ a: 1, b: "x" })).toBe(
			'{\n  "a": 1,\n  "b": "x"\n}',
		);
	});

	it("keeps a plain string as-is", () => {
		expect(formatToolArgs("ls -la")).toBe("ls -la");
	});

	it("returns empty for null/undefined", () => {
		expect(formatToolArgs(undefined)).toBe("");
		expect(formatToolArgs(null)).toBe("");
	});

	it("truncates past the cap with a marker", () => {
		const out = formatToolArgs("x".repeat(50), 10);
		expect(out).toBe(`${"x".repeat(10)}\n… (truncated)`);
	});

	it("does not throw on a circular structure", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => formatToolArgs(circular)).not.toThrow();
	});
});

describe("defaultDescribeArgs", () => {
	it("picks the salient arg for well-known tools", () => {
		expect(
			defaultDescribeArgs({ toolName: "bash", args: { command: "npm test" } }),
		).toBe("npm test");
		expect(
			defaultDescribeArgs({ toolName: "read", args: { file_path: "/a/b.ts" } }),
		).toBe("/a/b.ts");
		expect(
			defaultDescribeArgs({ toolName: "grep", args: { pattern: "TODO" } }),
		).toBe("TODO");
	});

	it("returns undefined when nothing obvious fits", () => {
		expect(
			defaultDescribeArgs({ toolName: "x", args: { count: 3 } }),
		).toBeUndefined();
		expect(defaultDescribeArgs({ toolName: "x", args: "raw" })).toBeUndefined();
	});
});

describe("toolActivityHtml", () => {
	it("builds a collapsed details block with tool name, hint and folded params", () => {
		const html = toolActivityHtml({
			toolName: "bash",
			args: { command: "echo hi" },
		}).html;
		expect(html).toContain("<details><summary>");
		expect(html).not.toContain("<details open>");
		expect(html).toContain("<code>bash</code>");
		expect(html).toContain("🔧");
		expect(html).toContain("echo hi"); // hint in summary
		expect(html).toContain('<pre><code class="language-json">');
	});

	it("can render expanded", () => {
		const html = toolActivityHtml(
			{ toolName: "read", args: { file_path: "a" } },
			{ open: true },
		).html;
		expect(html).toContain("<details open>");
	});

	it("shows a placeholder when there are no parameters", () => {
		const html = toolActivityHtml({ toolName: "noop" }).html;
		expect(html).toContain("(no parameters)");
	});

	it("escapes tool name and hint", () => {
		const html = toolActivityHtml({
			toolName: "weird<name>",
			args: { command: "a & b < c" },
		}).html;
		expect(html).toContain("weird&lt;name&gt;");
		expect(html).toContain("a &amp; b &lt; c");
	});

	it("collapses a multi-line hint to a single truncated line", () => {
		const html = toolActivityHtml(
			{ toolName: "bash", args: { command: "line1\nline2\nline3" } },
			{ maxHintChars: 10 },
		).html;
		const summary = html.slice(
			html.indexOf("<summary>"),
			html.indexOf("</summary>"),
		);
		expect(summary).not.toContain("\n");
		expect(summary).toContain("line1 line…");
	});
});

describe("toolActivityMessage", () => {
	it("wraps the html as an InputRichMessage", () => {
		const message = toolActivityMessage({
			toolName: "ls",
			args: { path: "/" },
		});
		expect(message.html).toBeDefined();
		expect(message.html).toContain("<code>ls</code>");
	});
});
