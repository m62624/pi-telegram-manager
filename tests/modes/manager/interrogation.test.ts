import { describe, expect, it } from "vitest";
import { DecisionState, FactState } from "../../../src/modes/manager/decision";
import {
	advance,
	createInterrogationTools,
	currentProbe,
	droppedFacts,
	FORGET_LIMIT,
	finalFacts,
	type InterrogationState,
	initInterrogation,
	isDone,
	type ProbeResult,
	ProbeState,
} from "../../../src/modes/manager/interrogation";

const LINES = ["I ordered a laptop for work", "I live in Almaty"];

/**
 * Drive the whole interrogation the way the runtime does: at each step read the
 * probe the state machine asks for, let a "model" answer it, feed the result
 * back. The model here reasons per probe — it answers each question differently
 * — and every candidate fact is verified on its own, independently of the rest.
 */
function runLoop(
	interlocutorName: string,
	model: (probeTool: string, state: InterrogationState) => ProbeResult | null,
	verifyLimit = 8,
): InterrogationState {
	let state = initInterrogation(interlocutorName);
	// Hard cap so a broken model can never hang the test.
	for (let step = 0; step < 20 && !isDone(state); step += 1) {
		const probe = currentProbe(state);
		const answer = model(probe.tool, state);
		state = advance(state, answer, LINES, verifyLimit);
	}
	return state;
}

describe("InterrogationLoop (iterative model interrogation)", () => {
	it("asks identify → candidates → per-fact verify, keeping only verified facts", () => {
		const asked: string[] = [];
		const state = runLoop("Alice", (tool, s) => {
			asked.push(tool);
			if (tool === "manager_identify") {
				return {
					tool: "identify",
					sameAsOwner: false,
					interlocutorName: "Alice",
				};
			}
			if (tool === "manager_candidates") {
				return {
					tool: "candidates",
					items: [
						{
							text: "ordered a laptop",
							subject: "interlocutor",
							durable: true,
						},
						{ text: "lives in Almaty", subject: "interlocutor", durable: true },
						{ text: "owner ships code", subject: "owner", durable: true },
						{ text: "tired today", subject: "interlocutor", durable: false },
					],
				};
			}
			// verify: each fact is judged on its OWN merits + its own evidence quote.
			const fact = s.queue[s.cursor]?.text;
			if (fact === "ordered a laptop") {
				return {
					tool: "verify",
					keep: true,
					evidenceQuote: "ordered a laptop",
				};
			}
			// The second surviving fact is rejected independently of the first.
			return { tool: "verify", keep: false };
		});

		// The loop iterated: one identify, one candidates, one verify PER survivor.
		expect(asked).toEqual([
			"manager_identify",
			"manager_candidates",
			"manager_verify",
			"manager_verify",
		]);
		expect(isDone(state)).toBe(true);
		expect(finalFacts(state).map((f) => f.text)).toEqual(["ordered a laptop"]);
	});

	it("aborts and saves nothing when the interlocutor is the owner (self-chat)", () => {
		const state = runLoop("Alice", (tool) =>
			tool === "manager_identify"
				? { tool: "identify", sameAsOwner: true }
				: null,
		);
		expect(isDone(state)).toBe(true);
		expect(finalFacts(state)).toEqual([]);
	});

	it("drops a verified fact whose evidence quote is not in the interlocutor's lines", () => {
		const state = runLoop("Alice", (tool) => {
			if (tool === "manager_identify") {
				return { tool: "identify", sameAsOwner: false };
			}
			if (tool === "manager_candidates") {
				return {
					tool: "candidates",
					items: [
						{ text: "secretly a spy", subject: "interlocutor", durable: true },
					],
				};
			}
			// Quote the model invented — it is not in LINES, so code rejects it.
			return { tool: "verify", keep: true, evidenceQuote: "i am a spy" };
		});
		expect(finalFacts(state)).toEqual([]);
	});

	it("caps how many candidates are individually verified", () => {
		let verifies = 0;
		runLoop(
			"Alice",
			(tool) => {
				if (tool === "manager_identify") {
					return { tool: "identify", sameAsOwner: false };
				}
				if (tool === "manager_candidates") {
					return {
						tool: "candidates",
						items: Array.from({ length: 5 }, (_, i) => ({
							text: `fact ${i}`,
							subject: "interlocutor" as const,
							durable: true,
						})),
					};
				}
				verifies += 1;
				return { tool: "verify", keep: false };
			},
			2,
		);
		expect(verifies).toBe(2);
	});

	it("ends after candidates when nothing survives the subject/durable filter", () => {
		const state = runLoop("Alice", (tool) => {
			if (tool === "manager_identify") {
				return { tool: "identify", sameAsOwner: false };
			}
			return {
				tool: "candidates",
				items: [{ text: "owner detail", subject: "owner", durable: true }],
			};
		});
		expect(isDone(state)).toBe(true);
		expect(finalFacts(state)).toEqual([]);
	});
});

describe("interrogation tools", () => {
	function toolMap(sink: ProbeState) {
		return new Map(createInterrogationTools(sink).map((t) => [t.name, t]));
	}

	it("manager_identify records the same-as-owner flag", async () => {
		const sink = new ProbeState();
		await toolMap(sink).get("manager_identify")?.execute("t", {
			same_as_owner: true,
			interlocutor_name: "Alice",
		});
		expect(sink.current()).toEqual({
			tool: "identify",
			sameAsOwner: true,
			interlocutorName: "Alice",
			ownerLinesPresent: false,
		});
	});

	it("manager_candidates coerces subjects/durability and drops empty text", async () => {
		const sink = new ProbeState();
		await toolMap(sink)
			.get("manager_candidates")
			?.execute("t", {
				items: [
					{
						text: "keep",
						subject: "interlocutor",
						durable: true,
						kind: "identity",
					},
					{ text: "  ", subject: "interlocutor", durable: true },
					{ text: "bad subject", subject: "nonsense", durable: true },
				],
			});
		expect(sink.current()).toEqual({
			tool: "candidates",
			items: [
				{
					text: "keep",
					subject: "interlocutor",
					durable: true,
					kind: "identity",
				},
				{
					text: "bad subject",
					subject: "other",
					durable: true,
					kind: undefined,
				},
			],
		});
	});

	it("manager_verify records keep + evidence", async () => {
		const sink = new ProbeState();
		await toolMap(sink)
			.get("manager_verify")
			?.execute("t", { keep: true, evidence_quote: "hi" });
		expect(sink.current()).toEqual({
			tool: "verify",
			keep: true,
			evidenceQuote: "hi",
		});
	});
});

// Ensure the decision + probe sinks stay independent (no accidental coupling).
describe("sink independence", () => {
	it("a probe result does not leak into the decision/fact sinks", () => {
		const decision = new DecisionState();
		const facts = new FactState();
		const probes = new ProbeState();
		probes.record({ tool: "identify", sameAsOwner: false });
		expect(decision.current()).toEqual({ kind: "none" });
		expect(facts.current()).toEqual([]);
		expect(probes.current()).not.toBeNull();
	});
});

/**
 * The review step: memory that only ever grows eventually lies.
 *
 * A fact was true when it was learned and can stop being true afterwards — the job
 * changed, the trip is over, the thing they were waiting for arrived. Before this step
 * nothing could remove a fact but a schema migration wiping every contact at once, so a
 * bot would resurface a corrected fact forever, with total confidence.
 *
 * Forgetting is gated by the SAME rule as remembering: the interlocutor's own words in
 * THIS conversation must say so, and code — not the model — checks the quote against
 * their lines.
 */
describe("interrogation review (unlearning)", () => {
	const KNOWN = [
		{ text: "Works at a bank", kind: "identity" as const },
		{ text: "Prefers voice notes", kind: "preference" as const },
	];
	/** Their own lines: one of them overturns the first fact, nothing overturns the second. */
	const LINES_NOW = ["I left the bank last month", "anyway, how are you"];

	function reviewOnly(
		answer: ProbeResult | null,
		known = KNOWN,
		lines = LINES_NOW,
	): InterrogationState {
		let state = initInterrogation("Alice", known);
		// identify → review
		state = advance(
			state,
			{ tool: "identify", sameAsOwner: false, interlocutorName: "Alice" },
			lines,
			8,
		);
		expect(currentProbe(state).tool).toBe("manager_forget");
		return advance(state, answer, lines, 8);
	}

	it("asks about what is remembered, by number, only when there is something to ask about", () => {
		const withMemory = advance(
			initInterrogation("Alice", KNOWN),
			{ tool: "identify", sameAsOwner: false },
			LINES_NOW,
			8,
		);
		const probe = currentProbe(withMemory);
		expect(probe.tool).toBe("manager_forget");
		expect(probe.directive).toContain("1. Works at a bank");
		expect(probe.directive).toContain("2. Prefers voice notes");

		// A contact with no memory has nothing to review: do not spend an inference asking
		// which of their zero facts has gone stale.
		const blank = advance(
			initInterrogation("Alice"),
			{ tool: "identify", sameAsOwner: false },
			LINES_NOW,
			8,
		);
		expect(currentProbe(blank).tool).toBe("manager_candidates");
	});

	it("drops a fact their own words overturn", () => {
		const state = reviewOnly({
			tool: "forget",
			items: [{ number: 1, evidenceQuote: "I left the bank last month" }],
		});
		expect(state.dropped.map((f) => f.text)).toEqual(["Works at a bank"]);
		expect(droppedFacts(state).map((f) => f.text)).toEqual(["Works at a bank"]);
		// And the pass carries on to what is NEW, as it always did.
		expect(state.phase).toBe("candidates");
	});

	it("keeps a fact the model wants gone but cannot quote", () => {
		// The whole safety of this step. A model that decides on its own that it "probably
		// does not need this any more" is a model that quietly erases what it was told — so
		// it must produce the sentence that overturns the fact, from their own lines, or the
		// fact stays. Unquoted, invented, or lifted from somebody else's words: no.
		expect(
			reviewOnly({ tool: "forget", items: [{ number: 1 }] }).dropped,
		).toEqual([]);
		expect(
			reviewOnly({
				tool: "forget",
				items: [{ number: 1, evidenceQuote: "they quit, I heard" }],
			}).dropped,
		).toEqual([]);
		// Quoted, but it overturns nothing that is not asked about: an out-of-range number
		// points at no fact at all.
		expect(
			reviewOnly({
				tool: "forget",
				items: [{ number: 9, evidenceQuote: "I left the bank last month" }],
			}).dropped,
		).toEqual([]);
	});

	it("caps how much one pass may forget", () => {
		// Even behind the evidence check, a single confused pass must not be able to empty a
		// contact's memory. What genuinely goes stale goes stale a fact or two at a time.
		const many = Array.from({ length: 6 }, (_, i) => ({
			text: `fact ${i + 1}`,
		}));
		const lines = ["none of that is true any more"];
		const state = reviewOnly(
			{
				tool: "forget",
				items: many.map((_, i) => ({
					number: i + 1,
					evidenceQuote: "none of that is true any more",
				})),
			},
			many,
			lines,
		);
		expect(state.dropped).toHaveLength(FORGET_LIMIT);
	});

	it("treats a fumbled review as 'nothing to unlearn', never as a reason to end the pass", () => {
		// Review is the one OPTIONAL step. Losing a whole interrogation because the model
		// muddled an optional question would cost more than the question is worth.
		const noAnswer = reviewOnly(null);
		expect(noAnswer.dropped).toEqual([]);
		expect(noAnswer.phase).toBe("candidates");

		const wrongTool = reviewOnly({ tool: "candidates", items: [] });
		expect(wrongTool.dropped).toEqual([]);
		expect(wrongTool.phase).toBe("candidates");
	});

	it("forgets nothing when the pass decided it does not know who this is", () => {
		// A self-chat aborts the pass. A pass that cannot say who it is looking at has no
		// business editing their memory — in either direction.
		const aborted = advance(
			initInterrogation("Alice", KNOWN),
			{ tool: "identify", sameAsOwner: true },
			LINES_NOW,
			8,
		);
		expect(isDone(aborted)).toBe(true);
		expect(droppedFacts(aborted)).toEqual([]);
		expect(finalFacts(aborted)).toEqual([]);
	});
});
