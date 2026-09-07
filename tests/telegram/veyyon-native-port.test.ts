import { describe, expect, it, vi } from "vitest";
import {
	bindVeyyonAgentControlPort,
	createVeyyonAgentControlPort,
	type TelegramNativeAuth,
	type TelegramNativeControlLike,
	type TelegramNativeControlHostLike,
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
		).rejects.toThrow("native agent session is no longer active");
		expect(bridge.getAgentDetail).not.toHaveBeenCalled();
	});

	it.each(["SESSION_MISMATCH", "SESSION_NOT_ACTIVE"])(
		"maps native %s to stale context without retrying another session",
		async (code) => {
			const bridge = bridgeFixture();
			bridge.listAgents = vi.fn(async () => {
				throw Object.assign(new Error("stale"), { code });
			});
			const port = createVeyyonAgentControlPort(bridge, auth);
			await expect(
				port.listAgents({ sessionId: "session-a", limit: 5 }),
			).rejects.toThrow("native agent session is no longer active");
			expect(bridge.listAgents).toHaveBeenCalledTimes(1);
		},
	);

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

describe("bindVeyyonAgentControlPort", () => {
	it("consumes the native in-process host and verifies its exact identity", async () => {
		const bridge = {
			...bridgeFixture(),
			getSessionIdentity: vi.fn(() => ({
				id: auth.sessionId,
				actorId: auth.actorId,
				chatId: auth.chatId,
			})),
		};
		const host: TelegramNativeControlHostLike = {
			version: 1,
			bind: vi.fn(() => bridge),
		};

		const port = bindVeyyonAgentControlPort(auth, ["C:/workspace"], host);
		expect(host.bind).toHaveBeenCalledWith({
			...auth,
			workspaceRoots: ["C:/workspace"],
		});
		await expect(
			port?.listAgents({ sessionId: auth.sessionId, limit: 5 }),
		).resolves.toMatchObject({
			items: [{ id: "agent-a", updatedAt: "2026-09-08T00:00:00Z" }],
		});
	});

	it("fails closed when a host returns another actor identity", () => {
		const host: TelegramNativeControlHostLike = {
			version: 1,
			bind: () => ({
				...bridgeFixture(),
				getSessionIdentity: () => ({
					id: auth.sessionId,
					actorId: "another-actor",
					chatId: auth.chatId,
				}),
			}),
		};
		expect(() =>
			bindVeyyonAgentControlPort(auth, ["C:/workspace"], host),
		).toThrow("native agent session is no longer active");
	});
});
