import { StaleAgentContextError } from "./agent-panel";
import type { AgentControlPort, AgentDetail, AgentPage } from "./agent-panel";

export interface TelegramNativeAuth {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
}

export interface NativeAgentPage {
	items: Array<{
		id: string;
		name: string;
		status: string;
		summary?: string;
		updatedAt?: string;
	}>;
	nextCursor?: string;
}

export interface TelegramNativeControlLike {
	listAgents(input: TelegramNativeAuth & { cursor?: string; limit: number }): Promise<NativeAgentPage>;
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


function nativeErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function mapNativeError(error: unknown): never {
	const code = nativeErrorCode(error);
	if (code === "SESSION_MISMATCH" || code === "SESSION_NOT_ACTIVE") {
		throw new StaleAgentContextError();
	}
	throw error;
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
			if (sessionId !== auth.sessionId) throw new StaleAgentContextError();
			let page: NativeAgentPage;
			try {
				page = await bridge.listAgents({ ...auth, cursor, limit });
			} catch (error) {
				mapNativeError(error);
			}
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
			if (sessionId !== auth.sessionId) throw new StaleAgentContextError();
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
				if (nativeErrorCode(error) === "AGENT_NOT_FOUND") return null;
				mapNativeError(error);
			}
		},
	};
}
