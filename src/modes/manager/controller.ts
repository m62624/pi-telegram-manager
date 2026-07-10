/**
 * The manager (mode 2) runtime brain, over injected ports.
 *
 * It multiplexes many Telegram business chats through one agent: classifies each
 * business update (interlocutor vs the owner's own manual message vs the bot's
 * own echo), records transcripts and contact profiles, drives the
 * {@link ChatScheduler} (one active chat at a time) and the {@link ReplyGate}
 * (the shared owner-reply window: an interlocutor message is held until the
 * owner stays silent past the window, then the whole chat batch is served),
 * triggers an agent turn for the active chat, and on turn end delivers the
 * model's `manager_reply` text back on behalf of the owner — tagged so the bot
 * never mistakes its own send for the owner.
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
import { buildContextLines } from "../../core/turns";
import {
	type ManagerInstructions,
	SYSTEM_INSTRUCTIONS_HEADER,
} from "../../instructions/builtin";
import type { BusinessStore } from "../../storage/business-store";
import type { ChatStore } from "../../storage/chat-store";
import type { ContactStore } from "../../storage/contact-store";
import type { SentRegistry } from "../../storage/sent-registry";
import type { ManagerSubMode } from "../../storage/singleton-store";
import { extractMessageContext } from "../../telegram/message-context";
import { extractProfileFromUser } from "../../telegram/profile";
import {
	boundaryDirective,
	buildIsolatedMessages,
	type IsolatedMessage,
} from "./context-isolation";
import { DecisionState, resolveDecision } from "./decision";
import { isBotMessage, stripBotMarker, tagBotText } from "./identity";
import { ChatScheduler } from "./scheduler";
import { ReplyGate } from "./submode";

/** A classified inbound business message (already extracted from the update). */
export interface BusinessMessageInput {
	connectionId: string;
	chatId: string;
	fromId?: number;
	message: Message;
}

/**
 * Final directive appended to the rebuilt context so a small local model
 * reliably ends the turn with a tool call rather than free-form text.
 */
export const MANAGER_ACTION_TRIGGER =
	"[Decide now on the latest messages above. End this turn by calling exactly " +
	"one tool — manager_reply to answer, or manager_silent to stay quiet and keep " +
	"observing. Never write plain text and never write a tool name as text.]";

export interface ManagerControllerDeps {
	subMode: ManagerSubMode;
	/** Assembled system-instruction blocks injected at the top of the context. */
	instructions: ManagerInstructions;
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

/**
 * Prefix a stored message with its cross-message context (forward origin, reply,
 * quote, cross-chat reply) so the model sees the same context in the manager as
 * in mode 1. Empty context leaves the text untouched.
 */
function withMessageContext(message: Message, text: string): string {
	const lines = buildContextLines(extractMessageContext(message));
	return lines.length > 0 ? `${lines.join("\n")}\n${text}` : text;
}

export class ManagerController {
	private readonly scheduler: ChatScheduler;
	private readonly gate: ReplyGate;
	private readonly decision = new DecisionState();
	private readonly chats = new Map<string, ChatMeta>();

	constructor(private readonly deps: ManagerControllerDeps) {
		this.scheduler = new ChatScheduler({
			continueWindowMs: deps.continueWindowMs,
			clock: deps.clock,
		});
		this.gate = new ReplyGate({
			subMode: deps.subMode,
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
				text: withMessageContext(input.message, stripBotMarker(text)),
				timestamp: now,
				senderId: ownerId,
				messageId,
			});
			// The owner answered inside the window — cancel this chat's pending batch
			// (takeover also freezes). The bot never replies to owner messages.
			this.gate.onOwnerMessage(chatId);
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
			text: withMessageContext(input.message, text),
			timestamp: now,
			senderId: from ? String(from.id) : undefined,
			senderName: contactName,
			messageId,
		});
		// Do NOT reply now: arm the owner-reply window and let the owner answer
		// first. onTick promotes the chat only if the window expires in silence.
		this.gate.onInterlocutorMessage(chatId);
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
		// This chat's batch is served — drop it and promote the next ready chat.
		this.gate.clearServed(active);
		this.scheduler.next();
		await this.triggerTurn();
	}

	/**
	 * Advance time: every chat whose owner-reply window expired in silence becomes
	 * ready (priority per chat/user via the scheduler's FIFO queue); then start a
	 * turn for the active chat if the agent is idle.
	 */
	async onTick(): Promise<void> {
		for (const chatId of this.gate.onTick()) {
			this.scheduler.onMessage(chatId);
		}
		await this.triggerTurn();
	}

	/**
	 * Rebuild the full message array the model sees for the active chat, or null
	 * when idle. Structure: the injected system-instruction block (so the model
	 * always knows it is the manager and must answer via a tool — present after a
	 * compaction too, since this runs before every LLM call), then the isolated
	 * chat history, then a final action directive.
	 */
	async buildContextForActive(): Promise<IsolatedMessage[] | null> {
		const active = this.scheduler.activeChat();
		if (active === null) return null;
		const records = await this.deps.chatStore.getRecent(
			active,
			this.deps.rememberMessages,
		);
		const meta = this.chats.get(active);
		const isolated = buildIsolatedMessages({
			records,
			boundary: boundaryDirective(meta?.contactName ?? active),
		});
		// First contact = no bot reply yet and at most this one interlocutor line.
		const isFirstMessage =
			!records.some((record) => record.author === "bot") &&
			records.filter((record) => record.author === "interlocutor").length <= 1;
		const system =
			`${SYSTEM_INSTRUCTIONS_HEADER}\n\n${this.deps.instructions.base}` +
			(isFirstMessage && this.deps.instructions.firstMessage
				? `\n\n${this.deps.instructions.firstMessage}`
				: "");
		return [
			{ role: "user", content: system },
			...isolated,
			{ role: "user", content: MANAGER_ACTION_TRIGGER },
		];
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

	/**
	 * Start a turn for the active chat when the agent is idle. The chat is only
	 * ever active after its owner-reply window expired (the gate), so there is no
	 * per-message permission check here.
	 */
	private async triggerTurn(): Promise<void> {
		const active = this.scheduler.activeChat();
		if (active === null || !this.deps.isIdle()) return;
		this.decision.reset();
		const meta = this.chats.get(active);
		if (meta) {
			await this.deps
				.typing({ connectionId: meta.connectionId, chatId: active })
				.catch(() => {});
		}
		await this.deps.triggerAgent(
			"Respond to the latest messages in the active Telegram chat by calling manager_reply or manager_silent.",
		);
	}
}

/** Extract a display name from a business-connection user (for stored metadata). */
export function connectionUserName(user: User): string {
	return extractProfileFromUser(user).displayName;
}
