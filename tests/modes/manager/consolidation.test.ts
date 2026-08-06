import { describe, expect, it } from "vitest";
import {
	CONSOLIDATION_DONE,
	CONSOLIDATION_INSTRUCTIONS,
	consolidationDirective,
	consolidationVerdict,
} from "../../../src/modes/manager/consolidation";
import { MemoryLedger } from "../../../src/modes/manager/memory-tools";

/**
 * The second queue, on its own.
 *
 * Everything else in the manager is settled by asking what reached Telegram. A memory
 * pass sends nothing to anybody, so that question has no answer for it — these are the
 * rules that replace it, and the reason they exist is that with the old step-counting
 * automaton gone, nothing in the shape of the conversation says when to stop.
 */

const limits = { maxSteps: 3, maxNudges: 2 };

function ledgerWith(steps: number): MemoryLedger {
	const ledger = new MemoryLedger();
	for (let i = 0; i < steps; i += 1) {
		ledger.startTurn();
		ledger.record({
			tool: "manager_recall",
			argsKey: `q${i}`,
			summary: `recalled q${i}`,
		});
	}
	return ledger;
}

describe("consolidationVerdict", () => {
	it("keeps going while the model is working", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		ledger.record({
			tool: "manager_recall",
			argsKey: "a",
			summary: "recalled a",
		});
		expect(consolidationVerdict(ledger, limits)).toBe("continue");
	});

	it("stops when the model says it is finished", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		ledger.finish();
		expect(consolidationVerdict(ledger, limits)).toBe("abort");
	});

	it("prods a silent turn, and gives up after the allowance", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		expect(consolidationVerdict(ledger, limits)).toBe("continue");
		ledger.startTurn();
		expect(consolidationVerdict(ledger, limits)).toBe("continue");
		ledger.startTurn();
		// maxNudges is 2: the third silence abandons the pass rather than paying for
		// another inference that will produce nothing.
		expect(consolidationVerdict(ledger, limits)).toBe("abort");
	});

	it("forgives a silence the model then breaks", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		consolidationVerdict(ledger, limits); // one nudge
		ledger.startTurn();
		ledger.record({
			tool: "manager_remember",
			argsKey: "x",
			summary: "stored x",
		});
		expect(consolidationVerdict(ledger, limits)).toBe("continue");
		expect(ledger.needsNudge()).toBe(false);
	});

	it("allows one sample past the budget, then stops", () => {
		const ledger = ledgerWith(3);
		// At the budget it is told to wrap up rather than cut off mid-thought.
		expect(consolidationVerdict(ledger, limits)).toBe("continue");
		ledger.startTurn();
		ledger.record({
			tool: "manager_recall",
			argsKey: "q4",
			summary: "one more",
		});
		expect(consolidationVerdict(ledger, limits)).toBe("abort");
	});
});

describe("consolidationDirective", () => {
	it("leads with the way out, so exploring is not the only option offered", () => {
		const directive = consolidationDirective(new MemoryLedger(), limits);
		expect(directive).toContain("manager_done");
		expect(directive).toContain("manager_recall");
		expect(directive).toContain("Do not write plain text");
	});

	it("hands back the journal when the model produced nothing", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		ledger.record({
			tool: "manager_remember",
			argsKey: "berlin",
			summary: "remembered 1 fact(s): moved to Berlin",
		});
		ledger.startTurn();
		consolidationVerdict(ledger, limits); // a silent turn
		const directive = consolidationDirective(ledger, limits);
		// The journal is the one thing the rebuilt context cannot contain: every sample of
		// a pass sees the same transcript and the same memory, so without it the model has
		// no way to know what it already did.
		expect(directive).toContain("without calling a tool");
		expect(directive).toContain("moved to Berlin");
	});

	it("warns on the last prompt before the pass is abandoned", () => {
		const ledger = new MemoryLedger();
		ledger.startTurn();
		consolidationVerdict(ledger, limits);
		ledger.startTurn();
		consolidationVerdict(ledger, limits);
		expect(consolidationDirective(ledger, limits)).toContain(
			"This is the last prompt",
		);
	});

	it("names a repeat, because nothing else in the prompt can", () => {
		const ledger = new MemoryLedger();
		for (let i = 0; i < 2; i += 1) {
			ledger.startTurn();
			ledger.record({
				tool: "manager_recall",
				argsKey: "where they work",
				summary: "recalled where they work → 0 hit(s)",
			});
		}
		const directive = consolidationDirective(ledger, limits);
		expect(directive).toContain("same call twice");
		expect(directive).toContain("will not");
	});

	it("asks the model to wrap up once the budget is spent", () => {
		const directive = consolidationDirective(ledgerWith(3), limits);
		expect(directive).toContain("used this pass's budget");
		// And says the work so far is safe, so "finish now" does not read as "lose it".
		expect(directive).toContain("nothing you have already stored");
	});

	it("ends a finished pass in its own terms, not a reply turn's", () => {
		// The bug: a pass was ended with the reply-turn directive ("you have already
		// decided this turn"). A model reading that mid-memory-review concluded it had
		// answered somebody, and wrote a word of prose for a chat it was never in.
		const ledger = new MemoryLedger();
		ledger.startTurn();
		ledger.finish();
		expect(consolidationDirective(ledger, limits)).toBe(CONSOLIDATION_DONE);
		expect(CONSOLIDATION_DONE).toContain("nothing to send");
	});

	it("prefers the budget warning over a repeat, because it ends the pass", () => {
		const ledger = new MemoryLedger();
		for (let i = 0; i < 3; i += 1) {
			ledger.startTurn();
			ledger.record({
				tool: "manager_recall",
				argsKey: "same",
				summary: "same",
			});
		}
		expect(consolidationDirective(ledger, limits)).toContain(
			"used this pass's budget",
		);
	});
});

describe("the consolidation system block", () => {
	it("says a standing question in the transcript is not addressed to it", () => {
		// Without this a model reading a transcript that ends in "so can you do it?"
		// concludes it is being asked — and starts answering somebody, in a turn that can
		// send nothing.
		expect(CONSOLIDATION_INSTRUCTIONS).toContain("not yours to answer now");
		expect(CONSOLIDATION_INSTRUCTIONS).toContain("Nobody is waiting for you");
	});
});
