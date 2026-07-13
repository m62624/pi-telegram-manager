import { describe, expect, it } from "vitest";
import {
	defaultDescribeArgs,
	formatToolArgs,
	toolActivityHtml,
	toolActivityLabel,
	toolActivityMessage,
	truncateTail,
	unwrapToolResult,
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
		// A shell command renders as a bash block, not a JSON wrapper.
		expect(html).toContain('<pre><code class="language-bash">');
		expect(html).not.toContain("language-json");
		expect(html).not.toContain('"command"');
	});

	it("renders a single non-shell string arg plainly, without a JSON wrapper", () => {
		const html = toolActivityHtml({
			toolName: "read",
			args: { file_path: "/a/b.ts" },
		}).html;
		expect(html).toContain("<pre>/a/b.ts</pre>");
		expect(html).not.toContain('"file_path"');
	});

	it("falls back to pretty JSON for multi-argument tools", () => {
		const html = toolActivityHtml({
			toolName: "grep",
			args: { pattern: "TODO", path: "src" },
		}).html;
		expect(html).toContain('<pre><code class="language-json">');
		expect(html).toContain('"pattern"');
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

describe("toolActivityLabel", () => {
	it("names the tool and its primary argument on one line", () => {
		expect(
			toolActivityLabel({ toolName: "bash", args: { command: "npm test" } }),
		).toBe("bash — npm test");
		expect(
			toolActivityLabel({
				toolName: "read",
				args: { file_path: "src/index.ts" },
			}),
		).toBe("read — src/index.ts");
	});

	it("falls back to the bare tool name when no argument speaks for it", () => {
		expect(toolActivityLabel({ toolName: "ls" })).toBe("ls");
		expect(toolActivityLabel({ toolName: "ls", args: { recurse: true } })).toBe(
			"ls",
		);
	});

	it("collapses a multi-line argument to one truncated line", () => {
		const label = toolActivityLabel(
			{ toolName: "bash", args: { command: "find .\n | sort\n | uniq" } },
			{ maxHintChars: 12 },
		);
		expect(label).toBe("bash — find . | sor…");
		expect(label).not.toContain("\n");
	});
});

describe("tool card status and result", () => {
	it("posts without a mark and completes with a tick", () => {
		expect(
			toolActivityHtml({ toolName: "bash", args: { command: "ls" } }).html,
		).not.toContain("✅");

		const done = toolActivityHtml({
			toolName: "bash",
			args: { command: "ls" },
			status: "ok",
			result: "a.ts\nb.ts",
		}).html;
		expect(done).toContain("✅");
		expect(done).toContain("<b>Result</b>");
		expect(done).toContain("a.ts\nb.ts");
	});

	it("marks a failure and titles its output as an error", () => {
		const failed = toolActivityHtml({
			toolName: "bash",
			args: { command: "exit 1" },
			status: "error",
			result: "command failed",
		}).html;
		expect(failed).toContain("❌");
		expect(failed).toContain("<b>Error</b>");
		expect(failed).not.toContain("<b>Result</b>");
	});

	it("marks a call the abort caught mid-flight", () => {
		const cancelled = toolActivityHtml({
			toolName: "bash",
			args: { command: "sleep 60" },
			status: "cancelled",
		}).html;
		expect(cancelled).toContain("⏹️");
		// Nothing came back, so there is no result section to show.
		expect(cancelled).not.toContain("<b>Result</b>");
	});

	it("escapes a result that would otherwise break the markup", () => {
		const html = toolActivityHtml({
			toolName: "read",
			args: { file_path: "a.html" },
			status: "ok",
			result: '<script>alert("x")</script> & </details>',
		}).html;
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&amp;");
		// The card's own structure survives: exactly one details block, still closed.
		expect(html.match(/<details/g)).toHaveLength(1);
		expect(html.endsWith("</details>")).toBe(true);
	});

	it("keeps a structured result as JSON and a string result as text", () => {
		const json = toolActivityHtml({
			toolName: "grep",
			args: { pattern: "x" },
			status: "ok",
			result: { matches: 3 },
		}).html;
		expect(json).toContain('<pre><code class="language-json">');
		expect(json).toContain('"matches": 3');

		const text = toolActivityHtml({
			toolName: "bash",
			args: { command: "echo hi" },
			status: "ok",
			result: "hi",
		}).html;
		// A shell log is not JSON and must not be quoted like one.
		expect(text).toContain("<pre>hi</pre>");
	});

	it("truncates a huge result instead of blowing the message limit", () => {
		const html = toolActivityHtml(
			{
				toolName: "bash",
				args: { command: "cat big" },
				status: "ok",
				result: "x".repeat(9000),
			},
			{ maxResultChars: 100 },
		).html;
		expect(html).toContain("… (truncated)");
		expect(html.length).toBeLessThan(1000);
	});

	it("shows no result section when the tool returned nothing", () => {
		const html = toolActivityHtml({
			toolName: "write",
			args: { file_path: "a" },
			status: "ok",
			result: "",
		}).html;
		expect(html).toContain("✅");
		expect(html).not.toContain("<b>Result</b>");
	});
});

describe("unwrapToolResult", () => {
	it("unwraps the SDK's result envelope into the plain output it carries", () => {
		// This is the bug the cards had: JSON-printing the envelope turned a directory
		// listing into {"content":[{"type":"text","text":".\n./.codex\n…
		expect(
			unwrapToolResult({
				content: [{ type: "text", text: ".\n./.codex\n./src" }],
				isError: false,
			}),
		).toBe(".\n./.codex\n./src");
	});

	it("joins several text parts and names an image instead of dumping it", () => {
		expect(
			unwrapToolResult({
				content: [
					{ type: "text", text: "before" },
					{ type: "image", data: "BASE64…", mimeType: "image/png" },
					{ type: "text", text: "after" },
				],
			}),
		).toBe("before\n[image]\nafter");
	});

	it("passes a bare string through and JSON-prints anything unrecognized", () => {
		expect(unwrapToolResult("plain output")).toBe("plain output");
		expect(unwrapToolResult({ matches: 3 })).toBe('{\n  "matches": 3\n}');
		expect(unwrapToolResult(null)).toBe("");
	});
});

describe("truncateTail", () => {
	it("keeps the END of a long output and counts what it dropped", () => {
		// The verdict of a command is at the bottom: an error, a summary, the last file.
		const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const out = truncateTail(text, 40);
		expect(out).toContain("line 100");
		expect(out).not.toContain("line 1\n");
		expect(out).toMatch(/^… \(\d+ earlier lines\)\n/);
	});

	it("starts at a line boundary, never mid-line", () => {
		const out = truncateTail("aaaa\nbbbb\ncccc", 6);
		expect(out).toBe("… (2 earlier lines)\ncccc");
	});

	it("leaves a short output untouched", () => {
		expect(truncateTail("short", 100)).toBe("short");
	});
});

describe("tool card result rendering", () => {
	it("renders a wrapped result as readable text, not as JSON", () => {
		const html = toolActivityHtml({
			toolName: "bash",
			args: { command: "find ." },
			status: "ok",
			result: { content: [{ type: "text", text: "./a.ts\n./b.ts" }] },
		}).html;
		expect(html).toContain("./a.ts\n./b.ts");
		expect(html).not.toContain('"content"');
		expect(html).not.toContain("\\n");
	});

	it("points at the full log when the tool saved one and we truncated", () => {
		const html = toolActivityHtml(
			{
				toolName: "bash",
				args: { command: "npm run build" },
				status: "ok",
				result: {
					content: [{ type: "text", text: "x".repeat(500) }],
					details: { fullOutputPath: "/tmp/pi-bash-1.log" },
				},
			},
			{ maxResultChars: 50 },
		).html;
		expect(html).toContain("<code>/tmp/pi-bash-1.log</code>");
	});

	it("does not point at a full log when nothing was truncated", () => {
		const html = toolActivityHtml({
			toolName: "bash",
			args: { command: "echo hi" },
			status: "ok",
			result: {
				content: [{ type: "text", text: "hi" }],
				details: { fullOutputPath: "/tmp/pi-bash-2.log" },
			},
		}).html;
		expect(html).not.toContain("/tmp/pi-bash-2.log");
	});
});
