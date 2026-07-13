import { describe, expect, it } from "vitest";
import { formatElapsed, ThinkingLog } from "../../src/telegram/thinking-log";

const T0 = 1_000_000;

describe("ThinkingLog", () => {
	it("animates only the headline before any tool is called", () => {
		// The model is sampling: there is nothing else true to say yet.
		const log = new ThinkingLog();
		expect(log.html(T0).html).toBe("<tg-thinking>Thinking…</tg-thinking>");
		expect(log.isEmpty()).toBe(true);
	});

	it("animates the running step and settles the finished ones", () => {
		const log = new ThinkingLog();
		log.start({
			callId: "1",
			toolName: "read",
			hint: "src/index.ts",
			startedAt: T0,
		});
		log.finish("1", T0 + 2_000, false);
		log.start({
			callId: "2",
			toolName: "bash",
			hint: "npm test",
			startedAt: T0 + 2_000,
		});

		const html = log.html(T0 + 6_000).html;
		// Exactly one thing moves, and it is the thing that is actually happening.
		expect(html.match(/<tg-thinking>/g)).toHaveLength(1);
		expect(html).toContain("<p>✓ <code>read</code> — src/index.ts (2s)</p>");
		expect(html).toContain(
			"<tg-thinking>▸ <code>bash</code> — npm test (4s)</tg-thinking>",
		);
	});

	it("crosses out a step that failed", () => {
		const log = new ThinkingLog();
		log.start({ callId: "1", toolName: "bash", hint: "exit 1", startedAt: T0 });
		log.finish("1", T0 + 1_500, true);
		const html = log.html(T0 + 1_500).html;
		expect(html).toContain("✕ <code>bash</code>");
		expect(html).not.toContain("✓ <code>bash</code>");
	});

	it("hides a duration nobody cares about", () => {
		// Every step is "0s" the instant it starts; showing that is just noise.
		const log = new ThinkingLog();
		log.start({ callId: "1", toolName: "ls", startedAt: T0 });
		expect(log.html(T0 + 200).html).toBe(
			"<tg-thinking>▸ <code>ls</code></tg-thinking>",
		);
	});

	it("collapses old steps so a long turn stays readable", () => {
		const log = new ThinkingLog();
		for (let i = 0; i < 9; i++) {
			log.start({ callId: String(i), toolName: `tool${i}`, startedAt: T0 });
			log.finish(String(i), T0 + 1, false);
		}
		const html = log.html(T0 + 1).html;
		expect(html).toContain("(3 earlier steps)");
		expect(html).not.toContain("tool0");
		expect(html).toContain("tool8");
	});

	it("keeps parallel calls apart", () => {
		const log = new ThinkingLog();
		log.start({ callId: "a", toolName: "read", startedAt: T0 });
		log.start({ callId: "b", toolName: "grep", startedAt: T0 });
		log.finish("b", T0 + 3_000, false);

		const html = log.html(T0 + 3_000).html;
		// "b" is done; "a" is still running and still counting.
		expect(html).toContain("✓ <code>grep</code> (3s)");
		expect(html).toContain(
			"<tg-thinking>▸ <code>read</code> (3s)</tg-thinking>",
		);
	});

	it("ignores the end of a call it never saw start", () => {
		const log = new ThinkingLog();
		expect(() => log.finish("ghost", T0, false)).not.toThrow();
		expect(log.isEmpty()).toBe(true);
	});

	it("clears between turns", () => {
		const log = new ThinkingLog();
		log.start({ callId: "1", toolName: "read", startedAt: T0 });
		log.clear();
		expect(log.isEmpty()).toBe(true);
		expect(log.html(T0).html).toBe("<tg-thinking>Thinking…</tg-thinking>");
	});

	it("escapes a hint that would otherwise break the markup", () => {
		const log = new ThinkingLog();
		log.start({
			callId: "1",
			toolName: "grep",
			hint: '<b>&"x"',
			startedAt: T0,
		});
		expect(log.html(T0).html).toContain("&lt;b&gt;&amp;");
	});
});

describe("formatElapsed", () => {
	it("counts seconds, then minutes", () => {
		expect(formatElapsed(4_000)).toBe("4s");
		expect(formatElapsed(59_000)).toBe("59s");
		expect(formatElapsed(80_000)).toBe("1m 20s");
		expect(formatElapsed(3_600_000)).toBe("60m 0s");
	});
});
