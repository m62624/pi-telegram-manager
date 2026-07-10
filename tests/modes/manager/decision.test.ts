import { describe, expect, it } from "vitest";
import {
	createManagerTools,
	DecisionState,
	MANAGER_TOOL_NAMES,
	resolveDecision,
} from "../../../src/modes/manager/decision";

function toolMap(sink: DecisionState) {
	const tools = createManagerTools(sink);
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
	it("exposes the two tool names", () => {
		expect(MANAGER_TOOL_NAMES).toEqual(["manager_reply", "manager_silent"]);
	});

	it("manager_reply records the text", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		const res = await tools
			.get("manager_reply")
			?.execute("t1", { text: "hello" });
		expect(state.current()).toEqual({ kind: "reply", text: "hello" });
		expect(res?.isError).toBeUndefined();
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
		await tools
			.get("manager_silent")
			?.execute("t1", { reason: "owner handling" });
		expect(state.current()).toEqual({
			kind: "silent",
			reason: "owner handling",
		});
	});
});
