import { describe, expect, it } from "vitest";
import {
	createManagerTools,
	DecisionState,
	FactState,
	MANAGER_TOOL_NAMES,
	resolveDecision,
} from "../../../src/modes/manager/decision";

function toolMap(sink: DecisionState, facts: FactState = new FactState()) {
	const tools = createManagerTools(sink, facts);
	return new Map(tools.map((t) => [t.name, t]));
}

describe("DecisionState + resolveDecision", () => {
	it("defaults to none → silent", () => {
		const state = new DecisionState();
		expect(state.current()).toEqual({ kind: "none" });
		expect(resolveDecision(state.current())).toBeNull();
	});

	it("resolves a reply to its text and silent/none to null", () => {
		expect(resolveDecision({ kind: "reply", text: "hi" })).toBe("hi");
		expect(resolveDecision({ kind: "reply", text: "  " })).toBeNull();
		expect(resolveDecision({ kind: "silent" })).toBeNull();
		expect(resolveDecision({ kind: "none" })).toBeNull();
	});

	it("downgrades a self-contradicting chatter reply to silence", () => {
		// The model replied but its own self-check says no reply is needed on chatter.
		expect(
			resolveDecision({
				kind: "reply",
				text: "lol",
				category: "chatter",
				needsReply: false,
			}),
		).toBeNull();
	});

	it("never downgrades when the model deems a reply needed", () => {
		expect(
			resolveDecision({
				kind: "reply",
				text: "Yes, in stock.",
				category: "question",
				needsReply: true,
			}),
		).toBe("Yes, in stock.");
		// chatter but the model still wants to reply → respected.
		expect(
			resolveDecision({
				kind: "reply",
				text: "haha true",
				category: "chatter",
				needsReply: true,
			}),
		).toBe("haha true");
	});

	it("keeps the first decisive call (a later one cannot override)", () => {
		const state = new DecisionState();
		state.record({ kind: "reply", text: "first" });
		state.record({ kind: "silent" });
		expect(state.current()).toEqual({ kind: "reply", text: "first" });
	});

	it("reset clears back to none", () => {
		const state = new DecisionState();
		state.record({ kind: "reply", text: "x" });
		state.reset();
		expect(state.current()).toEqual({ kind: "none" });
	});
});

describe("manager tools", () => {
	it("exposes the manager tool names incl. memory tools", () => {
		expect(MANAGER_TOOL_NAMES).toEqual([
			"manager_reply",
			"manager_silent",
			"manager_remember",
			"manager_skip",
		]);
	});

	it("manager_remember records de-duplicated non-empty facts", async () => {
		const facts = new FactState();
		const tools = toolMap(new DecisionState(), facts);
		await tools
			.get("manager_remember")
			?.execute("t1", { facts: ["lives in Almaty", "  ", "lives in Almaty"] });
		expect(facts.current()).toEqual(["lives in Almaty"]);
	});

	it("manager_skip fires the onSkip signal so the runtime can end the turn", async () => {
		let skipped = false;
		const tools = new Map(
			createManagerTools(new DecisionState(), new FactState(), () => {
				skipped = true;
			}).map((t) => [t.name, t]),
		);
		await tools.get("manager_skip")?.execute("t1", {});
		expect(skipped).toBe(true);
	});

	it("manager_reply records the text with its category and self-check", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		const res = await tools.get("manager_reply")?.execute("t1", {
			text: "hello",
			category: "question",
			needs_reply: true,
		});
		expect(state.current()).toEqual({
			kind: "reply",
			text: "hello",
			category: "question",
			needsReply: true,
		});
		expect(res?.isError).toBeUndefined();
	});

	it("manager_reply defaults an unknown category to 'question'", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		await tools
			.get("manager_reply")
			?.execute("t1", { text: "hi", category: "bogus", needs_reply: true });
		expect(state.current()).toMatchObject({ category: "question" });
	});

	it("manager_reply rejects empty text and records nothing", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		const res = await tools.get("manager_reply")?.execute("t1", { text: "  " });
		expect(res?.isError).toBe(true);
		expect(state.current()).toEqual({ kind: "none" });
	});

	it("manager_silent records silence with an optional reason", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		await tools.get("manager_silent")?.execute("t1", {
			reason: "owner handling",
			category: "chatter",
			needs_reply: false,
		});
		expect(state.current()).toEqual({
			kind: "silent",
			reason: "owner handling",
			category: "chatter",
			needsReply: false,
		});
	});
});
