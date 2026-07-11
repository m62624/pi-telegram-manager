import { describe, expect, it } from "vitest";
import { DecisionState, FactState } from "../../../src/modes/manager/decision";
import {
	advance,
	createInterrogationTools,
	currentProbe,
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
