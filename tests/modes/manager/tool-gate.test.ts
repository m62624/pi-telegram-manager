import { describe, expect, it } from "vitest";
import { managerToolGate } from "../../../src/modes/manager/tool-gate";

/** The owner's sandbox allowlist: the manager's own tools, plus whatever they permit. */
const base = {
	matches: (name: string) =>
		[
			"manager_reply",
			"manager_silent",
			"manager_remember",
			"manager_skip",
			"manager_resolve_draft",
			"manager_identify",
			"manager_forget",
			"manager_candidates",
			"manager_verify",
			"about",
		].includes(name),
};

const ordinary = { consolidating: false, revising: false };
const revise = { consolidating: false, revising: true };
const consolidation = { consolidating: true, revising: false };

describe("managerToolGate", () => {
	it("gives a consolidation pass the interrogation probes and NOTHING else", () => {
		// The bug this exists to prevent: a background memory pass was handed the reply
		// tools, so the model — seeing manager_reply and manager_silent in its list, and a
		// transcript ending in a question — reasoned itself into a reply turn, called
		// manager_silent "to end the turn", and wrote a word of prose for a chat it was
		// never talking to. There is nobody to answer on this turn.
		const gate = managerToolGate(base, consolidation);
		expect(gate.matches("manager_identify")).toBe(true);
		expect(gate.matches("manager_forget")).toBe(true);
		expect(gate.matches("manager_candidates")).toBe(true);
		expect(gate.matches("manager_verify")).toBe(true);

		expect(gate.matches("manager_reply")).toBe(false);
		expect(gate.matches("manager_silent")).toBe(false);
		expect(gate.matches("manager_remember")).toBe(false);
		expect(gate.matches("manager_skip")).toBe(false);
		expect(gate.matches("manager_resolve_draft")).toBe(false);
		expect(gate.matches("about")).toBe(false);
		expect(gate.matches("bash")).toBe(false);
	});

	it("gives a revise turn the one tool that can end it", () => {
		const gate = managerToolGate(base, revise);
		expect(gate.matches("manager_resolve_draft")).toBe(true);
		expect(gate.matches("manager_reply")).toBe(false);
		expect(gate.matches("manager_silent")).toBe(false);
		expect(gate.matches("manager_identify")).toBe(false);
	});

	it("gives an ordinary turn the sandbox, without the other turns' tools", () => {
		const gate = managerToolGate(base, ordinary);
		expect(gate.matches("manager_reply")).toBe(true);
		expect(gate.matches("manager_silent")).toBe(true);
		expect(gate.matches("manager_remember")).toBe(true);
		expect(gate.matches("about")).toBe(true);

		// A tool from another kind of turn does not merely go unused — it tells the model
		// what kind of turn it is in.
		expect(gate.matches("manager_resolve_draft")).toBe(false);
		expect(gate.matches("manager_identify")).toBe(false);
		expect(gate.matches("manager_candidates")).toBe(false);
		expect(gate.matches("manager_verify")).toBe(false);
		// And above all this one: a stranger writing into the chat must never be holding a
		// conversation with a bot that can be talked into FORGETTING things about them.
		// Unlearning belongs to the background memory pass, where nobody is being answered.
		expect(gate.matches("manager_forget")).toBe(false);
	});

	it("offers the same tools at every step of a memory pass", () => {
		// The tool schemas are rendered into the HEAD of the prompt (see
		// `pi/tool-visibility.ts`), so the tool list is not a menu — it is the first bytes
		// the backend reads, and the prefix it caches. A set that changed between the steps
		// of one pass would make the model re-read the whole interrogation from byte zero,
		// once per step. The gate is a function of the TURN KIND, not of the step, and this
		// is what makes that hold: adding the review step added a tool to the pass, and the
		// pass still offers one unchanging set from its first question to its last.
		const gate = managerToolGate(base, consolidation);
		const offered = [
			"manager_identify",
			"manager_forget",
			"manager_candidates",
			"manager_verify",
			"manager_reply",
			"manager_resolve_draft",
			"about",
			"bash",
		].filter((name) => gate.matches(name));
		expect(offered).toEqual([
			"manager_identify",
			"manager_forget",
			"manager_candidates",
			"manager_verify",
		]);
	});

	it("never lets anything through that the owner's sandbox refuses", () => {
		const gate = managerToolGate(base, ordinary);
		expect(gate.matches("bash")).toBe(false);
		expect(gate.matches("write")).toBe(false);
	});

	it("leaves a finished memory pass with no tool to call", () => {
		// Every step answered, nothing left to do — and the model, still holding the tool
		// for step one, called step one. Again. On a pass whose every step was answered,
		// until the runtime aborted the run: "Operation aborted", once per memory pass, in
		// the owner's feed. A finished instruction contradicted by a live tool is not an
		// instruction.
		const gate = managerToolGate(base, {
			consolidating: true,
			consolidationDone: true,
			revising: false,
		});
		for (const name of [
			"manager_identify",
			"manager_candidates",
			"manager_verify",
			"manager_reply",
			"manager_silent",
			"about",
		]) {
			expect(gate.matches(name)).toBe(false);
		}
	});

	it("lets the memory pass win when a chat also holds a draft", () => {
		// Both can be true at once: a chat can be holding a drafted reply while the idle
		// memory pass runs. The pass owns the turn, and the draft waits — resolving it
		// belongs to a turn that is actually talking to someone.
		const gate = managerToolGate(base, { consolidating: true, revising: true });
		expect(gate.matches("manager_identify")).toBe(true);
		expect(gate.matches("manager_resolve_draft")).toBe(false);
	});
});
