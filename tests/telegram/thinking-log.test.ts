import { describe, expect, it } from "vitest";
import { formatElapsed, ThinkingLog } from "../../src/telegram/thinking-log";

const T0 = 1_000_000;

describe("ThinkingLog", () => {
	it("animates the headline before any tool is called", () => {
		// The model is sampling: there is nothing else true to say yet.
		const log = new ThinkingLog();
		expect(log.html(T0).html).toBe("<tg-thinking>Thinking…</tg-thinking>");
		expect(log.isEmpty()).toBe(true);
	});

	it("shows the running step with its elapsed clock", () => {
		const log = new ThinkingLog();
		log.start({
			callId: "1",
			toolName: "bash",
			hint: "npm test",
			startedAt: T0,
		});
		expect(log.html(T0 + 4_000).html).toBe(
			"<tg-thinking>▸ <code>bash</code> — npm test (4s)</tg-thinking>",
		);
	});

	it("does NOT list finished steps — the tool cards already show them", () => {
		// Listing them printed the same call twice: once as a card with its ✅, once
		// again in the draft right underneath it.
		const log = new ThinkingLog();
		log.start({
			callId: "1",
			toolName: "bash",
			hint: "find . -type f",
			startedAt: T0,
		});
		log.finish("1", T0 + 2_000, false);

		const html = log.html(T0 + 2_000).html;
		expect(html).not.toContain("find . -type f");
		// Back to the headline: nothing is running, and the model is thinking again.
		expect(html).toBe("<tg-thinking>Thinking…</tg-thinking>");
	});

	it("moves on to the next call and forgets the finished one", () => {
		const log = new ThinkingLog();
		log.start({ callId: "1", toolName: "read", hint: "a.ts", startedAt: T0 });
		log.finish("1", T0 + 1_000, false);
		log.start({
			callId: "2",
			toolName: "grep",
			hint: "TODO",
			startedAt: T0 + 1_000,
		});

		const html = log.html(T0 + 3_000).html;
		expect(html).toBe(
			"<tg-thinking>▸ <code>grep</code> — TODO (2s)</tg-thinking>",
		);
		expect(html).not.toContain("read");
	});

	it("waits on the OLDEST call still in flight when several run at once", () => {
		const log = new ThinkingLog();
		log.start({ callId: "a", toolName: "read", startedAt: T0 });
		log.start({ callId: "b", toolName: "grep", startedAt: T0 + 500 });
		// The younger one returns; the turn is still waiting on the older one.
		log.finish("b", T0 + 1_000, false);
		expect(log.html(T0 + 3_000).html).toBe(
			"<tg-thinking>▸ <code>read</code> (3s)</tg-thinking>",
		);
	});

	it("hides a duration nobody cares about", () => {
		// Every step is "0s" the instant it starts; showing that is just noise.
		const log = new ThinkingLog();
		log.start({ callId: "1", toolName: "ls", startedAt: T0 });
		expect(log.html(T0 + 200).html).toBe(
			"<tg-thinking>▸ <code>ls</code></tg-thinking>",
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
