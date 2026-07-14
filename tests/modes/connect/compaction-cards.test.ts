import { describe, expect, it } from "vitest";
import {
	compactedCard,
	compactingCard,
	compactionFailedCard,
	humanTokens,
} from "../../../src/modes/connect/compaction-cards";

describe("humanTokens", () => {
	it("scales a count to the unit a reader can hold in their head", () => {
		expect(humanTokens(0)).toBe("0");
		expect(humanTokens(840)).toBe("840");
		expect(humanTokens(1_000)).toBe("1k");
		expect(humanTokens(203_456)).toBe("203.5k");
		expect(humanTokens(1_240_000)).toBe("1.2M");
	});

	it("does not pretend to know a count that makes no sense", () => {
		expect(humanTokens(Number.NaN)).toBe("?");
		expect(humanTokens(-1)).toBe("?");
	});
});

describe("compactingCard", () => {
	it("names who started it — the owner, the threshold, or an overflow", () => {
		expect(compactingCard("manual")).toContain("you asked for it (/compact)");
		expect(compactingCard("threshold")).toContain("the context is filling up");
		expect(compactingCard("overflow")).toContain("overflowed the context");
	});

	it("shows how full the context was when it started", () => {
		const text = compactingCard("threshold", { tokens: 203_456, percent: 84 });
		expect(text).toContain("~203.5k tokens (84% full)");
	});

	it("says only what Pi actually knows", () => {
		// Right after a compaction Pi reports tokens as null until the next response.
		expect(
			compactingCard("manual", { tokens: null, percent: null }),
		).not.toContain("tokens");
		// A known count with an unknown percentage still says the count.
		const partial = compactingCard("manual", { tokens: 12_000, percent: null });
		expect(partial).toContain("~12k tokens");
		expect(partial).not.toContain("%");
	});
});

describe("compactedCard", () => {
	it("reports what the history weighed before it was summarised", () => {
		const text = compactedCard(203_456);
		expect(text).toContain("✅");
		expect(text).toContain("~203.5k tokens");
	});

	it("still confirms success when no count came back", () => {
		const text = compactedCard(undefined);
		expect(text).toContain("Context compacted");
		expect(text).not.toContain("tokens");
	});
});

describe("compactionFailedCard", () => {
	it("shows the failure and says the context survived it", () => {
		const text = compactionFailedCard("summariser model is unavailable");
		expect(text).toContain("❌");
		expect(text).toContain("summariser model is unavailable");
		expect(text).toContain("left as it is");
	});

	it("never renders an empty reason", () => {
		expect(compactionFailedCard("   ")).toContain("no reason given");
	});
});
