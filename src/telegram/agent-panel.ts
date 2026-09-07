import { randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "@grammyjs/types";

export const AGENT_PAGE_SIZE = 5;
const CALLBACK_PREFIX = "agent:";
const CALLBACK_TTL_MS = 10 * 60 * 1000;

export interface AgentSummary {
	id: string;
	name: string;
	status: string;
	progress?: string;
	updatedAt?: string;
}

export interface AgentResultMedia {
	kind: "photo" | "document";
	path: string;
	caption?: string;
}

export interface AgentDetail extends AgentSummary {
	result?: string;
	media?: readonly AgentResultMedia[];
}

export interface AgentPage {
	items: readonly AgentSummary[];
	nextCursor?: string;
	previousCursor?: string;
}

export interface AgentControlPort {
	listAgents(input: {
		sessionId: string;
		cursor?: string;
		limit: number;
	}): Promise<AgentPage>;
	getAgent(input: { sessionId: string; agentId: string }): Promise<AgentDetail | null>;
}

export interface AgentPanelBinding {
	sessionId: string;
	chatId: number;
	userId: number;
}

type AgentPanelAction =
	| { kind: "page"; cursor?: string }
	| { kind: "detail"; agentId: string }
	| { kind: "list" };

interface ScopedAction {
	binding: AgentPanelBinding;
	action: AgentPanelAction;
	expiresAt: number;
	consumed: boolean;
}

export type CallbackResolution =
	| { ok: true; action: AgentPanelAction }
	| { ok: false; reason: "foreign" | "expired" | "replayed" | "unknown" };

/**
 * Opaque, one-shot callback tokens. Agent/session ids never enter callback_data;
 * the token is bound to the active native session, private chat, and operator.
 */
export class AgentCallbackScope {
	private readonly actions = new Map<string, ScopedAction>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly token: () => string = () => randomBytes(12).toString("base64url"),
	) {}

	issue(binding: AgentPanelBinding, action: AgentPanelAction): string {
		const value = `${CALLBACK_PREFIX}${this.token()}`;
		this.actions.set(value, {
			binding: { ...binding },
			action,
			expiresAt: this.now() + CALLBACK_TTL_MS,
			consumed: false,
		});
		return value;
	}

	consume(data: string, binding: AgentPanelBinding): CallbackResolution {
		const record = this.actions.get(data);
		if (!record) return { ok: false, reason: "unknown" };
		if (record.consumed) return { ok: false, reason: "replayed" };
		if (record.expiresAt < this.now()) return { ok: false, reason: "expired" };
		if (
			record.binding.sessionId !== binding.sessionId ||
			record.binding.chatId !== binding.chatId ||
			record.binding.userId !== binding.userId
		) {
			return { ok: false, reason: "foreign" };
		}
		record.consumed = true;
		return { ok: true, action: record.action };
	}
}

function compact(value: string | undefined, max: number): string {
	const normalized = (value ?? "").replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function statusIcon(status: string): string {
	const value = status.toLowerCase();
	if (value.includes("run") || value.includes("work")) return "▶";
	if (value.includes("fail") || value.includes("error")) return "✕";
	if (value.includes("done") || value.includes("complete")) return "✓";
	if (value.includes("wait") || value.includes("block")) return "‖";
	return "•";
}

export function agentListText(page: AgentPage, sessionLabel: string): string {
	const lines = [`Agents · ${compact(sessionLabel, 48)}`, ""];
	if (page.items.length === 0) lines.push("No agents are visible in this session.");
	for (const agent of page.items) {
		lines.push(`${statusIcon(agent.status)} ${compact(agent.name, 44)} — ${compact(agent.status, 24)}`);
		if (agent.progress) lines.push(`  ${compact(agent.progress, 120)}`);
	}
	lines.push("", "Tap an agent for progress and results.");
	return lines.join("\n");
}

export function agentDetailText(agent: AgentDetail, sessionLabel: string): string {
	const lines = [
		`${statusIcon(agent.status)} ${compact(agent.name, 64)}`,
		`Session: ${compact(sessionLabel, 48)}`,
		`Status: ${compact(agent.status, 40)}`,
	];
	if (agent.updatedAt) lines.push(`Updated: ${compact(agent.updatedAt, 40)}`);
	if (agent.progress) lines.push("", "Progress", compact(agent.progress, 1200));
	if (agent.result) lines.push("", "Result", compact(agent.result, 2400));
	return lines.join("\n");
}

export function buildAgentListKeyboard(
	page: AgentPage,
	binding: AgentPanelBinding,
	scope: AgentCallbackScope,
): InlineKeyboardMarkup {
	const inline_keyboard = page.items.map((agent) => [
		{
			text: `${statusIcon(agent.status)} ${compact(agent.name, 34)}`,
			callback_data: scope.issue(binding, { kind: "detail", agentId: agent.id }),
		},
	]);
	const navigation: Array<{ text: string; callback_data: string }> = [];
	if (page.previousCursor !== undefined) {
		navigation.push({
			text: "‹ Newer",
			callback_data: scope.issue(binding, { kind: "page", cursor: page.previousCursor }),
		});
	}
	if (page.nextCursor !== undefined) {
		navigation.push({
			text: "Older ›",
			callback_data: scope.issue(binding, { kind: "page", cursor: page.nextCursor }),
		});
	}
	if (navigation.length > 0) inline_keyboard.push(navigation);
	return { inline_keyboard };
}

export function buildAgentDetailKeyboard(
	binding: AgentPanelBinding,
	scope: AgentCallbackScope,
): InlineKeyboardMarkup {
	return {
		inline_keyboard: [[{ text: "‹ All agents", callback_data: scope.issue(binding, { kind: "list" }) }]],
	};
}

export function isAgentCommand(text: string): boolean {
	return /^\/agents?(?:@\w+)?(?:\s+.*)?$/i.test(text.trim());
}

export function parseAgentCommand(text: string): { kind: "list" } | { kind: "detail"; agentId: string } | null {
	const match = text.trim().match(/^\/(agents?|agent)(?:@\w+)?(?:\s+(.+))?$/i);
	if (!match) return null;
	const id = match[2]?.trim();
	if (match[1].toLowerCase() === "agent" && id) return { kind: "detail", agentId: id };
	return { kind: "list" };
}
