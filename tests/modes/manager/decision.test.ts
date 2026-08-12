import { describe, expect, it } from "vitest";
import {
	createDraftResolveTool,
	createManagerTools,
	DecisionState,
	DraftResolutionState,
	MANAGER_TOOL_NAMES,
	resolveDecision,
} from "../../../src/modes/manager/decision";

function toolMap(sink: DecisionState) {
	return new Map(createManagerTools(sink).map((t) => [t.name, t]));
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
	it("exposes exactly the two tools that can end a turn", () => {
		// The memory verbs used to be in this list. They live in `memory-tools.ts` now:
		// a turn still has to end in reply or silence, and remembering is not either.
		expect(MANAGER_TOOL_NAMES).toEqual([
			"telegram_manager_reply",
			"telegram_manager_silent",
		]);
	});

	it("telegram_manager_resolve_draft records send / refine / drop", async () => {
		const state = new DraftResolutionState();
		const tool = createDraftResolveTool(state);
		expect(tool.name).toBe("telegram_manager_resolve_draft");

		await tool.execute("t1", { action: "send" });
		expect(state.current()).toEqual({ action: "send" });

		state.reset();
		await tool.execute("t2", { action: "refine", text: "  rewritten  " });
		expect(state.current()).toEqual({ action: "refine", text: "rewritten" });

		state.reset();
		await tool.execute("t3", { action: "drop", reason: "answered themselves" });
		expect(state.current()).toEqual({
			action: "drop",
			reason: "answered themselves",
		});
	});

	it("telegram_manager_resolve_draft 'refine' without text is an error (draft not lost)", async () => {
		const state = new DraftResolutionState();
		const tool = createDraftResolveTool(state);
		const res = await tool.execute("t1", { action: "refine" });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(state.current()).toEqual({ action: "none" });
	});

	it("telegram_manager_resolve_draft treats an unknown action as a safe 'send'", async () => {
		const state = new DraftResolutionState();
		const tool = createDraftResolveTool(state);
		await tool.execute("t1", { action: "bogus" });
		expect(state.current()).toEqual({ action: "send" });
	});

	it("telegram_manager_reply records the text with its category and self-check", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		const res = await tools.get("telegram_manager_reply")?.execute("t1", {
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

	it("telegram_manager_reply defaults an unknown category to 'question'", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		await tools
			.get("telegram_manager_reply")
			?.execute("t1", { text: "hi", category: "bogus", needs_reply: true });
		expect(state.current()).toMatchObject({ category: "question" });
	});

	it("telegram_manager_reply rejects empty text and records nothing", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		const res = await tools
			.get("telegram_manager_reply")
			?.execute("t1", { text: "  " });
		expect(res?.isError).toBe(true);
		expect(state.current()).toEqual({ kind: "none" });
	});

	it("telegram_manager_silent records silence with an optional reason", async () => {
		const state = new DecisionState();
		const tools = toolMap(state);
		await tools.get("telegram_manager_silent")?.execute("t1", {
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
