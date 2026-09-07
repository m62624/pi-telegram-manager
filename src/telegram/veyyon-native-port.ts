import type {
	AgentControlPort,
	AgentDetail,
	AgentPage,
} from "./agent-panel";

export interface TelegramNativeAuth {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
}

export interface TelegramNativeControlLike {
	listAgents(input: TelegramNativeAuth & { cursor?: string; limit: number }): Promise<{
		items: Array<{
			id: string;
			name: string;
			status: string;
			summary?: string;
			updatedAt?: string;
		}>;
		nextCursor?: string;
	}>;
	getAgentDetail(input: TelegramNativeAuth & { agentId: string }): Promise<{
		id: string;
		name: string;
		status: string;
		summary?: string;
		progress?: string;
		result?: string;
		updatedAt?: string;
	}>;
}

export interface NativeControlErrorLike {
	code?: string;
}

function isAgentNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "AGENT_NOT_FOUND"
	);
}

/**
 * Maps the authenticated native bridge into the Telegram presentation port.
 * Authentication and exact actor/chat/session checks remain native-owned.
 */
export function createVeyyonAgentControlPort(
	bridge: TelegramNativeControlLike,
	auth: TelegramNativeAuth,
): AgentControlPort {
	return {
		async listAgents({ sessionId, cursor, limit }): Promise<AgentPage> {
			if (sessionId !== auth.sessionId) throw new Error("SESSION_BINDING_MISMATCH");
			const page = await bridge.listAgents({ ...auth, cursor, limit });
			return {
				items: page.items.map((agent) => ({
					id: agent.id,
					name: agent.name,
					status: agent.status,
					progress: agent.summary,
					updatedAt: agent.updatedAt,
				})),
				nextCursor: page.nextCursor,
			};
		},
		async getAgent({ sessionId, agentId }): Promise<AgentDetail | null> {
			if (sessionId !== auth.sessionId) throw new Error("SESSION_BINDING_MISMATCH");
			try {
				const agent = await bridge.getAgentDetail({ ...auth, agentId });
				return {
					id: agent.id,
					name: agent.name,
					status: agent.status,
					progress: agent.progress ?? agent.summary,
					result: agent.result,
					updatedAt: agent.updatedAt,
				};
			} catch (error) {
				if (isAgentNotFound(error)) return null;
				throw error;
			}
		},
	};
}
