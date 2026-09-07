import { describe, expect, it } from "vitest";
import {
	agentDetailText,
	agentListText,
	AgentCallbackScope,
	buildAgentDetailKeyboard,
	buildAgentListKeyboard,
	isAgentCommand,
	parseAgentCommand,
	type AgentPage,
} from "../../src/telegram/agent-panel";

const binding = { sessionId: "session-a", chatId: 42, userId: 42 };
const page: AgentPage = {
	items: [
		{ id: "worker-a", name: "Research images", status: "running", progress: "Reading Bot API" },
		{ id: "worker-b", name: "Verify output", status: "completed", progress: "Contract passed" },
	],
	nextCursor: "opaque-next",
};

describe("agent visibility panel", () => {
	it("renders readable status and bounded progress", () => {
		expect(agentListText(page, "Main · project-a")).toBe(
			"Agents · Main · project-a\n\n▶ Research images — running\n  Reading Bot API\n✓ Verify output — completed\n  Contract passed\n\nTap an agent for progress and results.",
		);
		expect(
			agentDetailText(
				{
					...page.items[1],
					result: "Image delivered through Telegram photo output.",
					updatedAt: "2026-09-08T00:00:00Z",
				},
				"Main · project-a",
			),
		).toContain("Result\nImage delivered through Telegram photo output.");
	});

	it("paginates without exposing agent, cursor, session, or chat ids in callback data", () => {
		let sequence = 0;
		const scope = new AgentCallbackScope(() => 1_000, () => `token-${++sequence}`);
		const keyboard = buildAgentListKeyboard(page, binding, scope);
		const callbacks = keyboard.inline_keyboard.flatMap((row) =>
			row.map((button) => button.callback_data ?? ""),
		);
		expect(callbacks).toEqual(["agent:token-1", "agent:token-2", "agent:token-3"]);
		for (const value of callbacks) {
			expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
			expect(value).not.toContain("worker");
			expect(value).not.toContain("session");
			expect(value).not.toContain("opaque-next");
		}
	});

	it("binds callbacks to session/chat/operator and consumes them once", () => {
		const scope = new AgentCallbackScope(() => 1_000, () => "opaque");
		const data = buildAgentDetailKeyboard(binding, scope).inline_keyboard[0][0]
			.callback_data as string;
		expect(
			scope.consume(data, { ...binding, sessionId: "session-b" }),
		).toEqual({ ok: false, reason: "foreign" });
		expect(scope.consume(data, binding)).toEqual({
			ok: true,
			action: { kind: "list" },
		});
		expect(scope.consume(data, binding)).toEqual({
			ok: false,
			reason: "replayed",
		});
	});

	it("expires callbacks rather than applying stale native-session actions", () => {
		let now = 1_000;
		const scope = new AgentCallbackScope(() => now, () => "opaque");
		const data = buildAgentDetailKeyboard(binding, scope).inline_keyboard[0][0]
			.callback_data as string;
		now += 11 * 60 * 1_000;
		expect(scope.consume(data, binding)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it("recognizes list and exact detail commands while preserving other free text", () => {
		expect(isAgentCommand("/agents")).toBe(true);
		expect(parseAgentCommand("/agent worker-a")).toEqual({
			kind: "detail",
			agentId: "worker-a",
		});
		expect(parseAgentCommand("please inspect agents")).toBeNull();
	});
});
