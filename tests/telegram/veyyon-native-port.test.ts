import { describe, expect, it, vi } from "vitest";
import {
	createVeyyonAgentControlPort,
	type TelegramNativeAuth,
	type TelegramNativeControlLike,
} from "../../src/telegram/veyyon-native-port";

const auth: TelegramNativeAuth = {
	authToken: "synthetic-auth",
	actorId: "operator-a",
	chatId: "chat-a",
	sessionId: "session-a",
};

function bridgeFixture(): TelegramNativeControlLike {
	return {
		listAgents: vi.fn(async () => ({
			items: [
				{
					id: "agent-a",
					name: "Research",
					status: "running",
					summary: "Reading constraints",
					updatedAt: "2026-09-08T00:00:00Z",
				},
			],
			nextCursor: "cursor-b",
		})),
		getAgentDetail: vi.fn(async () => ({
			id: "agent-a",
			name: "Research",
			status: "completed",
			progress: "Complete",
			result: "Constraints documented",
		})),
	};
}

describe("createVeyyonAgentControlPort", () => {
	it("passes exact native authentication and maps sanitized visibility DTOs", async () => {
		const bridge = bridgeFixture();
		const port = createVeyyonAgentControlPort(bridge, auth);
		await expect(
			port.listAgents({ sessionId: "session-a", cursor: "cursor-a", limit: 5 }),
		).resolves.toEqual({
			items: [
				{
					id: "agent-a",
					name: "Research",
					status: "running",
					progress: "Reading constraints",
					updatedAt: "2026-09-08T00:00:00Z",
				},
			],
			nextCursor: "cursor-b",
		});
		expect(bridge.listAgents).toHaveBeenCalledWith({
			...auth,
			cursor: "cursor-a",
			limit: 5,
		});
	});

	it("refuses to cross the bound native session", async () => {
		const bridge = bridgeFixture();
		const port = createVeyyonAgentControlPort(bridge, auth);
		await expect(
			port.getAgent({ sessionId: "session-b", agentId: "agent-a" }),
		).rejects.toThrow("SESSION_BINDING_MISMATCH");
		expect(bridge.getAgentDetail).not.toHaveBeenCalled();
	});

	it("maps native AGENT_NOT_FOUND to a stale-panel null without hiding other errors", async () => {
		const bridge = bridgeFixture();
		bridge.getAgentDetail = vi.fn(async () => {
			throw Object.assign(new Error("gone"), { code: "AGENT_NOT_FOUND" });
		});
		const port = createVeyyonAgentControlPort(bridge, auth);
		await expect(
			port.getAgent({ sessionId: "session-a", agentId: "agent-a" }),
		).resolves.toBeNull();
	});
});
