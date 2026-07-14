import { describe, expect, it } from "vitest";
import type { ContextSnapshot } from "../../../src/core/context-measure";
import {
	renderContextCard,
	renderContextText,
} from "../../../src/modes/connect/context-card";

const snapshot = (over: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	source: "personal",
	takenAt: 0,
	messages: 42,
	counts: { user: 12, assistant: 15, tool: 15, other: 0 },
	chars: { instructions: 4000, user: 8000, assistant: 8000, tool: 120_000 },
	images: 0,
	...over,
});

const NOW = Date.UTC(2026, 6, 14, 12, 30);

describe("renderContextCard", () => {
	it("says what the context is made of, biggest part first", () => {
		const card = renderContextCard({ snapshot: snapshot(), now: NOW });
		expect(card).toContain("- Made of — ");
		// Tool output is 120k of the 140k characters — that is the answer to "why did it
		// forget", and it has to be the first thing on the line.
		expect(card).toMatch(/Made of.*tool output ~30k \(86%\)/);
		expect(card.indexOf("tool output")).toBeLessThan(
			card.indexOf("your messages"),
		);
	});

	it("shows the exact size of the last call and our estimate of the next", () => {
		// Two different moments. Showing one and calling it "the context" is how you end
		// up trusting a number that was never about the thing you are looking at.
		const card = renderContextCard({
			snapshot: snapshot(),
			usage: { tokens: 24_529, contextWindow: 131_072, percent: 18.7 },
			now: NOW,
		});
		expect(card).toContain("- Last call — 24.5k of 131.1k tokens (19% full)");
		expect(card).toContain(
			"- Next call — ~35k tokens estimated, over 42 messages",
		);
	});

	it("names the source, so isolation is something you can see holding", () => {
		expect(
			renderContextCard({
				snapshot: snapshot({ source: "manager-chat" }),
				now: NOW,
			}),
		).toContain("one chat only");
		expect(
			renderContextCard({
				snapshot: snapshot({ source: "mixed-coding" }),
				now: NOW,
			}),
		).toContain("Telegram turns stripped out");
	});

	it("says a compaction happened, and when — that is the usual answer", () => {
		const card = renderContextCard({
			snapshot: snapshot(),
			compaction: { at: NOW - 68 * 60_000, tokensBefore: 120_712 },
			now: NOW,
		});
		expect(card).toContain("- Compacted — 1h ago");
		expect(card).toContain("120.7k tokens replaced by a summary");
		expect(card).toContain("I know only from the summary");
	});

	it("stays quiet about a compaction that never happened", () => {
		expect(renderContextCard({ snapshot: snapshot(), now: NOW })).not.toContain(
			"Compacted",
		);
	});

	it("warns only once the context is nearly full", () => {
		const nearlyFull = renderContextCard({
			snapshot: snapshot(),
			usage: { tokens: 110_000, contextWindow: 131_072, percent: 84 },
			now: NOW,
		});
		expect(nearlyFull).toContain("Nearly full");
		const roomy = renderContextCard({
			snapshot: snapshot(),
			usage: { tokens: 20_000, contextWindow: 131_072, percent: 15 },
			now: NOW,
		});
		expect(roomy).not.toContain("Nearly full");
	});

	it("admits it has nothing to report before the first turn", () => {
		const card = renderContextCard({ now: NOW });
		expect(card).toContain("nothing to measure");
	});

	it("leaves out what Pi does not report, rather than guessing it", () => {
		const card = renderContextCard({
			snapshot: snapshot(),
			usage: { tokens: null, contextWindow: 0, percent: null },
			now: NOW,
		});
		expect(card).not.toContain("Last call");
		expect(card).toContain("Next call");
	});

	it("counts images, whose cost their text never shows", () => {
		expect(
			renderContextCard({ snapshot: snapshot({ images: 3 }), now: NOW }),
		).toContain("- Images — 3 inline");
	});
});

describe("renderContextText", () => {
	it("drops the markdown for the plain-text modes", () => {
		const text = renderContextText({ snapshot: snapshot(), now: NOW });
		expect(text).not.toContain("**");
		expect(text).toContain("• Built from");
	});
});
