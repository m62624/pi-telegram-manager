/**
 * The manager (mode 2) runtime brain, over injected ports.
 *
 * It multiplexes many Telegram business chats through one agent: classifies each
 * business update (interlocutor vs the owner's own manual message vs the bot's
 * own echo), records transcripts and contact profiles, drives the
 * {@link ChatScheduler} (one active chat at a time, continuation window) and the
 * {@link TakeoverMachine} (observer/takeover freezing), triggers an agent turn
 * for the active chat, and on turn end delivers the model's `manager_reply` text
 * back on behalf of the owner — tagged so the bot never mistakes its own send
 * for the owner.
 *
 * Every Pi/grammY specific arrives as a port (agent trigger, business send,
 * typing, the stores), so the coordination is unit-testable with fakes;
 * `index.ts` wires the ports to the live runtime, a wall-clock tick to
 * {@link ManagerController.onTick}, and `pi.on("context")` to
 * {@link ManagerController.buildContextForActive}.
 */
import type { BusinessConnection, Message, User } from "@grammyjs/types";
import { applyLabeler } from "../../core/render";
import type { Clock } from "../../core/timers";
import type { BusinessStore } from "../../storage/business-store";
import type { ChatStore } from "../../storage/chat-store";
import type { ContactStore } from "../../storage/contact-store";
import type { SentRegistry } from "../../storage/sent-registry";
import type { ManagerSubMode } from "../../storage/singleton-store";
import { extractProfileFromUser } from "../../telegram/profile";
import {
	boundaryDirective,
	buildIsolatedMessages,
	type IsolatedMessage,
} from "./context-isolation";
import { DecisionState, resolveDecision } from "./decision";
import { isBotMessage, stripBotMarker, tagBotText } from "./identity";
import { ChatScheduler } from "./scheduler";
import { botMayReply, TakeoverMachine } from "./submode";

/** A classified inbound business message (already extracted from the update). */
export interface BusinessMessageInput {
	connectionId: string;
	chatId: string;
	fromId?: number;
	message: Message;
}

export interface ManagerControllerDeps {
	subMode: ManagerSubMode;
	labeler: string;
	rememberMessages: number;
	continueWindowMs: number;
	ownerReplyWindowMs: number;
	clock: Clock;
	chatStore: ChatStore;
	contactStore: ContactStore;
	sentRegistry: SentRegistry;
	businessStore: BusinessStore;
	/** Whether the agent is free to take a new turn. */
	isIdle: () => boolean;
	/** Start an agent turn for the active chat (the prompt is a bare trigger). */
	triggerAgent: (prompt: string) => Promise<void>;
	/** Send a reply on behalf of the owner; returns the sent message id. */
	sendReply: (args: {
		connectionId: string;
		chatId: string;
		text: string;
	}) => Promise<number>;
	/** Show the typing indicator on a business chat. */
	typing: (args: { connectionId: string; chatId: string }) => Promise<void>;
}

interface ChatMeta {
	connectionId: string;
	contactName: string;
}

/** Text a message carries — body or media caption. */
function messageText(message: Message): string {
	return message.text ?? message.caption ?? "";
}

export class ManagerController {
	private readonly scheduler: ChatScheduler;
	private readonly takeover: TakeoverMachine;
	private readonly decision = new DecisionState();
	private readonly chats = new Map<string, ChatMeta>();

	constructor(private readonly deps: ManagerControllerDeps) {
		this.scheduler = new ChatScheduler({
			continueWindowMs: deps.continueWindowMs,
			clock: deps.clock,
		});
		this.takeover = new TakeoverMachine({
			ownerReplyWindowMs: deps.ownerReplyWindowMs,
			clock: deps.clock,
		});
	}

	/** The per-turn decision sink the manager tools write into. */
	decisionSink(): DecisionState {
		return this.decision;
	}

	/** Persist a connected/updated business account. */
	async onBusinessConnection(input: {
		connectionId: string;
		connection: BusinessConnection;
		isEnabled: boolean;
	}): Promise<void> {
		const user = input.connection.user;
		const now = this.deps.clock.now();
		await this.deps.businessStore.upsert({
			id: input.connectionId,
			userId: String(user.id),
			userChatId:
				input.connection.user_chat_id === undefined
					? undefined
					: String(input.connection.user_chat_id),
			userName: extractProfileFromUser(user).displayName,
			canReply: input.connection.rights?.can_reply,
			canReadMessages: input.connection.rights?.can_read_messages,
			isEnabled: input.isEnabled,
			connectedAt: now,
			updatedAt: now,
		});
	}

	/** Handle an inbound business message; may start a turn for the active chat. */
	async onBusinessMessage(input: BusinessMessageInput): Promise<void> {
		const { chatId } = input;
		const text = messageText(input.message);
		const messageId = input.message.message_id;
		const now = this.deps.clock.now();
		const connection = await this.deps.businessStore.get(input.connectionId);
		const ownerId = connection?.userId;
		const fromOwnerSide =
			ownerId !== undefined && String(input.fromId) === ownerId;

		if (fromOwnerSide) {
			// The owner's side: either the bot's own echo (ignore) or a manual
			// message (freeze the chat in takeover).
			const bot = await isBotMessage(
				{ chatId, messageId, text },
				this.deps.sentRegistry,
			);
			if (bot) return;
			await this.deps.chatStore.append(chatId, {
				author: "owner",
				text: stripBotMarker(text),
				timestamp: now,
				senderId: ownerId,
				messageId,
			});
			this.takeover.onOwnerMessage(chatId);
			return;
		}

		// The interlocutor.
		const from = input.message.from;
		const contactName = from
			? extractProfileFromUser(from).displayName
			: chatId;
		this.chats.set(chatId, { connectionId: input.connectionId, contactName });
		if (from) {
			await this.deps.contactStore.upsertProfile(
				extractProfileFromUser(from),
				now,
			);
		}
		await this.deps.chatStore.append(chatId, {
			author: "interlocutor",
			text,
			timestamp: now,
			senderId: from ? String(from.id) : undefined,
			senderName: contactName,
			messageId,
		});
		this.takeover.onInterlocutorMessage(chatId);
		const outcome = this.scheduler.onMessage(chatId);
		if (
			(outcome === "active" || outcome === "continued") &&
			botMayReply(this.deps.subMode, this.takeover, chatId)
		) {
			await this.triggerTurn();
		}
	}

	/** Resolve the finished turn's decision and deliver a reply if the model chose to. */
	async onAgentEnd(): Promise<void> {
		const active = this.scheduler.activeChat();
		if (active === null) return;
		const text = resolveDecision(this.decision.current());
		this.decision.reset();
		if (text) {
			const meta = this.chats.get(active);
			if (meta) {
				const outgoing = tagBotText(applyLabeler(text, this.deps.labeler));
				const messageId = await this.deps.sendReply({
					connectionId: meta.connectionId,
					chatId: active,
					text: outgoing,
				});
				await this.deps.sentRegistry.recordSent(active, messageId);
				await this.deps.chatStore.append(active, {
					author: "bot",
					text,
					timestamp: this.deps.clock.now(),
					messageId,
				});
			}
		}
		// Arm the continuation window; if the interlocutor goes quiet, onTick moves on.
		this.scheduler.onReplied();
	}

	/** Advance timers: promote the next chat / re-engage after an owner-reply window. */
	async onTick(): Promise<void> {
		const { promoted } = this.scheduler.onTick();
		const unfrozen = this.takeover.onTick();
		const active = this.scheduler.activeChat();
		if (promoted !== null || (active !== null && unfrozen.includes(active))) {
			await this.triggerTurn();
		}
	}

	/** Rebuild the isolated message array for the active chat, or null when idle. */
	async buildContextForActive(): Promise<IsolatedMessage[] | null> {
		const active = this.scheduler.activeChat();
		if (active === null) return null;
		const records = await this.deps.chatStore.getRecent(
			active,
			this.deps.rememberMessages,
		);
		const meta = this.chats.get(active);
		return buildIsolatedMessages({
			records,
			boundary: boundaryDirective(meta?.contactName ?? active),
		});
	}

	/** Status for the banner/footer. */
	status(): { subMode: ManagerSubMode; activeChat?: string; queued: number } {
		const active = this.scheduler.activeChat();
		return {
			subMode: this.deps.subMode,
			activeChat: active ?? undefined,
			queued: this.scheduler.pending().length,
		};
	}

	/** Start a turn for the active chat when idle and the bot is allowed to reply. */
	private async triggerTurn(): Promise<void> {
		const active = this.scheduler.activeChat();
		if (active === null || !this.deps.isIdle()) return;
		if (!botMayReply(this.deps.subMode, this.takeover, active)) return;
		this.decision.reset();
		const meta = this.chats.get(active);
		if (meta) {
			await this.deps
				.typing({ connectionId: meta.connectionId, chatId: active })
				.catch(() => {});
		}
		await this.deps.triggerAgent(
			"Respond to the latest message in the active Telegram chat by calling manager_reply or manager_silent.",
		);
	}
}

/** Extract a display name from a business-connection user (for stored metadata). */
export function connectionUserName(user: User): string {
	return extractProfileFromUser(user).displayName;
}
