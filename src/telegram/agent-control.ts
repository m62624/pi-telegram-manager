import type { InlineKeyboardMarkup } from "@grammyjs/types";
import {
	AGENT_PAGE_SIZE,
	agentDetailText,
	agentListText,
	AgentCallbackScope,
	buildAgentDetailKeyboard,
	buildAgentListKeyboard,
	isStaleAgentContextError,
	parseAgentCommand,
	type AgentControlPort,
	type AgentPanelBinding,
	type AgentResultMedia,
} from "./agent-panel";

export interface AgentPanelOutput {
	sendMessage(input: {
		chatId: number;
		text: string;
		replyMarkup?: InlineKeyboardMarkup;
	}): Promise<{ messageId: number }>;
	editMessage(input: {
		chatId: number;
		messageId: number;
		text: string;
		replyMarkup?: InlineKeyboardMarkup;
	}): Promise<void>;
	answerCallback(input: { callbackQueryId: string; text?: string }): Promise<void>;
	sendPhoto(input: { chatId: number; path: string; caption?: string }): Promise<void>;
	sendDocument(input: { chatId: number; path: string; caption?: string }): Promise<void>;
}

export interface AgentControlContext extends AgentPanelBinding {
	sessionLabel: string;
}

export interface AgentCallbackInput {
	data: string;
	callbackQueryId: string;
	messageId?: number;
}

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

/** Defense in depth for display DTOs accidentally containing common credential shapes. */
export function sanitizeAgentText(value: string): string {
	return value
		.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
		.replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
		.slice(0, TELEGRAM_TEXT_LIMIT);
}

/**
 * Telegram-only presentation over a native agent-control port. It never discovers
 * processes or owns execution; the native host supplies session-bound visibility.
 */
export class AgentControlController {
	constructor(
		private readonly native: AgentControlPort,
		private readonly output: AgentPanelOutput,
		private readonly callbacks = new AgentCallbackScope(),
	) {}

	async handleCommand(text: string, context: AgentControlContext): Promise<boolean> {
		const command = parseAgentCommand(text);
		if (!command) return false;
		try {
			if (command.kind === "detail") {
				await this.showDetail(context, command.agentId);
			} else {
				await this.showList(context);
			}
		} catch (error) {
			if (!isStaleAgentContextError(error)) throw error;
			await this.output.sendMessage({
				chatId: context.chatId,
				text: "This session is no longer active. Open /agents in the current session.",
			});
		}
		return true;
	}

	async handleCallback(input: AgentCallbackInput, context: AgentControlContext): Promise<boolean> {
		if (!input.data.startsWith("agent:")) return false;
		const resolution = this.callbacks.consume(input.data, context);
		if (!resolution.ok) {
			await this.output.answerCallback({
				callbackQueryId: input.callbackQueryId,
				text: resolution.reason === "replayed" ? "Already handled." : "This agent view is no longer valid.",
			});
			return true;
		}
		// Telegram clients keep a spinner visible until every callback is answered.
		await this.output.answerCallback({ callbackQueryId: input.callbackQueryId });
		try {
			if (resolution.action.kind === "detail") {
				await this.showDetail(context, resolution.action.agentId, input.messageId);
			} else {
				await this.showList(
					context,
					resolution.action.kind === "page" ? resolution.action.cursor : undefined,
					input.messageId,
				);
			}
		} catch (error) {
			if (!isStaleAgentContextError(error)) throw error;
			const text = "This session is no longer active. Open /agents in the current session.";
			if (input.messageId !== undefined) {
				await this.output.editMessage({
					chatId: context.chatId,
					messageId: input.messageId,
					text,
				});
			} else {
				await this.output.sendMessage({ chatId: context.chatId, text });
			}
		}
		return true;
	}

	private async showList(
		context: AgentControlContext,
		cursor?: string,
		messageId?: number,
	): Promise<void> {
		const page = await this.native.listAgents({
			sessionId: context.sessionId,
			cursor,
			limit: AGENT_PAGE_SIZE,
		});
		const text = sanitizeAgentText(agentListText(page, context.sessionLabel));
		const replyMarkup = buildAgentListKeyboard(page, context, this.callbacks);
		if (messageId !== undefined) {
			await this.output.editMessage({ chatId: context.chatId, messageId, text, replyMarkup });
		} else {
			await this.output.sendMessage({ chatId: context.chatId, text, replyMarkup });
		}
	}

	private async showDetail(
		context: AgentControlContext,
		agentId: string,
		messageId?: number,
	): Promise<void> {
		const agent = await this.native.getAgent({ sessionId: context.sessionId, agentId });
		if (!agent) {
			const text = "That agent is no longer visible in this session.";
			if (messageId !== undefined) {
				await this.output.editMessage({ chatId: context.chatId, messageId, text });
			} else {
				await this.output.sendMessage({ chatId: context.chatId, text });
			}
			return;
		}
		const text = sanitizeAgentText(agentDetailText(agent, context.sessionLabel));
		const replyMarkup = buildAgentDetailKeyboard(context, this.callbacks);
		if (messageId !== undefined) {
			await this.output.editMessage({ chatId: context.chatId, messageId, text, replyMarkup });
		} else {
			await this.output.sendMessage({ chatId: context.chatId, text, replyMarkup });
		}
		for (const media of agent.media ?? []) await this.sendResultMedia(context.chatId, media);
	}

	private async sendResultMedia(chatId: number, media: AgentResultMedia): Promise<void> {
		const caption = media.caption
			? sanitizeAgentText(media.caption).slice(0, TELEGRAM_CAPTION_LIMIT)
			: undefined;
		if (media.kind === "photo") {
			await this.output.sendPhoto({ chatId, path: media.path, caption });
		} else {
			await this.output.sendDocument({ chatId, path: media.path, caption });
		}
	}
}
