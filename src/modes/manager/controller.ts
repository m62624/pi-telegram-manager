/**
 * The manager (mode 2) runtime brain, over injected ports.
 *
 * It multiplexes many Telegram business chats through one agent: classifies each
 * business update (interlocutor vs the owner's own manual message vs the bot's
 * own echo), records transcripts and contact profiles, and drives turn-taking
 * with two cooperating pieces:
 *
 *  - the {@link ReplyGate} — the shared owner-reply window: a *first* interlocutor
 *    message is held for `ownerReplyWindowMs` (5 min) so the owner gets first
 *    crack; only if the owner stays silent does the chat become ready;
 *  - the {@link ChatScheduler} — one active chat at a time, never-replied chats
 *    first, plus a `continueWindowMs` (1:30) continuation window from the bot's
 *    reply that keeps a chat active while the conversation is live.
 *
 * A chat is only handed a turn while it has an unanswered interlocutor message
 * (`unserved`), so the agent never spins on an already-answered chat. On turn end
 * the model's `manager_reply` text is delivered on behalf of the owner (tagged so
 * the bot never mistakes its own send for the owner); `manager_silent` releases
 * the chat to the next in line.
 *
 * Every Pi/grammY specific arrives as a port, so the coordination is unit-testable
 * with fakes; `index.ts` wires the ports to the live runtime.
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
import { describeAttachments, isImage } from "../../telegram/media";
import { extractMessageContext } from "../../telegram/message-context";
import { extractProfileFromUser } from "../../telegram/profile";
import {
	boundaryDirective,
	buildIsolatedMessages,
	type IsolatedImage,
	type IsolatedMessage,
} from "./context-isolation";
import { analyzeChat, type ConversationState } from "./conversation-state";
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

/** What inbound media the manager forwards to the model. */
export interface ManagerMediaPolicy {
	images: boolean;
	documents: boolean;
}

/**
 * Final directive appended to the rebuilt context so a small local model
 * reliably ends the turn with a tool call rather than free-form text.
 */
export const MANAGER_ACTION_TRIGGER =
	"[Decide now on the latest messages above. First classify the latest message " +
	"(category) and self-check needs_reply, then end this turn by calling exactly " +
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
	/** Byte cap for describing/downloading inbound attachments. */
	maxBytes: number;
	/** Which inbound media reaches the model (images vision / documents). */
	media: ManagerMediaPolicy;
	clock: Clock;
	chatStore: ChatStore;
	contactStore: ContactStore;
	sentRegistry: SentRegistry;
	businessStore: BusinessStore;
	/** Whether the agent is free to take a new turn. */
	isIdle: () => boolean;
	/** Download an interlocutor message's inline images (empty when none/disabled). */
	loadImages?: (message: Message) => Promise<IsolatedImage[]>;
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

/** A short human-readable state line injected so the model decides deliberately. */
function stateSummary(state: ConversationState): string {
	if (state.interlocutorWaiting) {
		return "[State: the interlocutor sent the latest message and is waiting; the owner has not answered. Decide whether a reply is needed.]";
	}
	if (state.lastAuthor === "owner") {
		return "[State: the owner spoke last. Stay silent unless you are directly addressed.]";
	}
	return "[State: you replied last. Continue only if there is something to add.]";
}

export class ManagerController {
	private readonly scheduler: ChatScheduler;
	private readonly gate: ReplyGate;
	private readonly decision = new DecisionState();
	private readonly chats = new Map<string, ChatMeta>();
	/** Chats with an interlocutor message the model has not answered yet. */
	private readonly unserved = new Set<string>();
	/** Freshest downloaded images per chat (in-memory, newest turn only). */
	private readonly latestImages = new Map<string, IsolatedImage[]>();

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
		// Telegram `date` is Unix seconds; use the real send time as the record's
		// timestamp so backlog delivered after downtime carries its true age (the
		// gate/scheduler timers still run off the wall clock, i.e. from arrival).
		const messageTime = input.message.date ? input.message.date * 1000 : now;
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
				timestamp: messageTime,
				senderId: ownerId,
				messageId,
			});
			// The owner answered inside the window — cancel this chat's pending batch
			// (takeover also freezes). The bot never replies to owner messages, and
			// the chat is no longer waiting on us.
			this.gate.onOwnerMessage(chatId);
			this.unserved.delete(chatId);
			this.latestImages.delete(chatId);
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
		const media = await this.ingestMedia(chatId, input.message);
		const baseText = withMessageContext(input.message, text);
		const storedText = media.note
			? baseText
				? `${media.note} ${baseText}`
				: media.note
			: baseText;
		await this.deps.chatStore.append(chatId, {
			author: "interlocutor",
			text: storedText,
			timestamp: messageTime,
			senderId: from ? String(from.id) : undefined,
			senderName: contactName,
			messageId,
			kind: media.kind,
		});
		this.unserved.add(chatId);
		if (this.scheduler.activeChat() === chatId) {
			// A continuation of the active chat: cancel its continuation-release so it
			// stays active; it will be served on the next tick. No 5-min wait.
			this.scheduler.onMessage(chatId);
		} else {
			// First engagement: arm the owner-reply window and let the owner answer
			// first. onTick promotes the chat only if the window expires in silence.
			this.gate.onInterlocutorMessage(chatId);
		}
	}

	/**
	 * Apply the media policy to an interlocutor message: download images for vision
	 * (kept in memory for the freshest turn), refuse documents. Returns a text note
	 * to fold into the stored transcript and the primary attachment kind, if any.
	 */
	private async ingestMedia(
		chatId: string,
		message: Message,
	): Promise<{ note: string; kind?: string }> {
		const refs = describeAttachments(message, this.deps.maxBytes);
		if (refs.length === 0) return { note: "" };
		const images = refs.filter(isImage);
		const documents = refs.filter((ref) => !isImage(ref));
		const parts: string[] = [];
		if (images.length > 0) {
			if (this.deps.media.images) {
				parts.push("[image]");
				const loaded = (await this.deps.loadImages?.(message)) ?? [];
				if (loaded.length > 0) this.latestImages.set(chatId, loaded);
			} else {
				parts.push("[image not shown]");
			}
		}
		for (const doc of documents) {
			const name = doc.fileName ? `: ${doc.fileName}` : "";
			parts.push(
				this.deps.media.documents
					? `[document${name}]`
					: "[document not accepted]",
			);
		}
		return { note: parts.join(" "), kind: refs[0]?.kind };
	}

	/**
	 * Seed a chat as ready to serve without the owner-reply window — used by
	 * catch-up on activation, where the wait has already elapsed. The chat is
	 * never-replied, so the scheduler naturally prioritises it.
	 */
	markReady(chatId: string, meta: ChatMeta): void {
		this.chats.set(chatId, meta);
		this.unserved.add(chatId);
		this.scheduler.onMessage(chatId);
	}

	/** Resolve the finished turn's decision and deliver a reply if the model chose to. */
	async onAgentEnd(): Promise<void> {
		const active = this.scheduler.activeChat();
		if (active === null) return;
		const text = resolveDecision(this.decision.current());
		this.decision.reset();
		// This chat has been served this turn, whatever the model decided.
		this.unserved.delete(active);
		this.latestImages.delete(active);
		this.gate.clearServed(active);
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
			// Replied: keep the chat active and arm the 1:30 continuation window.
			this.scheduler.onReplied();
		} else {
			// Silent: this batch is done — release the chat and promote the next.
			this.scheduler.next();
		}
		await this.triggerTurn();
	}

	/**
	 * Advance time: chats whose owner-reply window expired in silence become ready
	 * (first engagement), and the active chat is released when its continuation
	 * window lapses; then start a turn if the agent is idle.
	 */
	async onTick(): Promise<void> {
		for (const chatId of this.gate.onTick()) {
			this.scheduler.onMessage(chatId);
		}
		this.scheduler.onTick();
		await this.triggerTurn();
	}

	/**
	 * Rebuild the full message array the model sees for the active chat, or null
	 * when idle. Structure: the injected system-instruction block (rules, plus a
	 * one-line state summary so the model decides deliberately), then the isolated
	 * chat history (with the freshest interlocutor image attached), then a final
	 * action directive.
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
			latestImages: this.latestImages.get(active),
		});
		// First contact = no bot reply yet and at most this one interlocutor line.
		const isFirstMessage =
			!records.some((record) => record.author === "bot") &&
			records.filter((record) => record.author === "interlocutor").length <= 1;
		const system =
			`${SYSTEM_INSTRUCTIONS_HEADER}\n\n${this.deps.instructions.base}` +
			(isFirstMessage && this.deps.instructions.firstMessage
				? `\n\n${this.deps.instructions.firstMessage}`
				: "") +
			`\n\n${stateSummary(analyzeChat(records))}`;
		return [
			{ role: "user", content: system },
			...isolated,
			{ role: "user", content: MANAGER_ACTION_TRIGGER },
		];
	}

	/** Status for the banner/footer. */
	status(): {
		subMode: ManagerSubMode;
		activeChat?: string;
		queued: number;
		holding: number;
	} {
		const active = this.scheduler.activeChat();
		return {
			subMode: this.deps.subMode,
			activeChat: active ?? undefined,
			queued: this.scheduler.pending().length,
			// Chats held in the owner-reply (5-min) window — waiting, not yet queued.
			holding: this.gate.pendingCount(),
		};
	}

	/**
	 * Start a turn for the active chat when the agent is idle AND the chat still
	 * has an unanswered interlocutor message. Runs only while idle, so it never
	 * mutates the active slot mid-turn (which would misattribute the reply).
	 *
	 * First it releases any chat that became active but is already answered — e.g.
	 * the owner replied to a chat while it sat queued — so the active slot never
	 * stalls. A chat kept active for its continuation window (nothing unanswered
	 * but a window still pending) is left alone; the unserved guard then stops the
	 * agent re-triggering on it.
	 */
	private async triggerTurn(): Promise<void> {
		if (!this.deps.isIdle()) return;
		while (
			this.scheduler.activeChat() !== null &&
			!this.unserved.has(this.scheduler.activeChat() as string) &&
			this.scheduler.continuationRemaining() === null
		) {
			this.scheduler.next();
		}
		const active = this.scheduler.activeChat();
		if (active === null || !this.unserved.has(active)) return;
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
