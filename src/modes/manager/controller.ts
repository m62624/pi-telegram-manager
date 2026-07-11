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
import type { BusinessConnection, Message } from "@grammyjs/types";
import { formatNowLine } from "../../core/datetime";
import type { Clock } from "../../core/timers";
import { buildContextLines } from "../../core/turns";
import {
	type ManagerInstructions,
	SYSTEM_INSTRUCTIONS_HEADER,
} from "../../instructions/builtin";
import type { BusinessStore } from "../../storage/business-store";
import type { ChatMessageRecord, ChatStore } from "../../storage/chat-store";
import type { ConsolidationQueue } from "../../storage/consolidation-queue";
import type {
	ContactFact,
	ContactStore,
	FactKind,
} from "../../storage/contact-store";
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
import { DecisionState, FactState, resolveDecision } from "./decision";
import { isBotMessage, stripBotMarker } from "./identity";
import {
	advance as advanceInterrogation,
	currentProbe,
	finalFacts,
	type InterrogationState,
	initInterrogation,
	isDone,
	ProbeState,
} from "./interrogation";
import { matchesMention } from "./mention";
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
	"observing. You may also call manager_remember first to save a durable fact. " +
	"Never write plain text and never write a tool name as text.]";

/**
 * Replaces the action trigger once the turn's terminal decision is already
 * recorded. If the agent loop re-samples the model before the turn-end abort
 * lands (a race, or after a non-terminal manager_remember), this tells the model
 * the decision is made so it ends the turn instead of repeating the same tool
 * call against otherwise-identical context.
 */
export const MANAGER_TURN_DONE =
	"[You have already decided this turn. Do not call any more tools. Reply with a " +
	"single word to end the turn.]";

/**
 * Trailing directive when a drafted reply is held back because new messages
 * arrived mid-turn: the model reconsiders it against the newer messages and
 * either resends it, revises it, or drops it.
 */
export function reviseDirective(draft: string): string {
	return (
		`[You were about to send this reply: «${draft}». Since then the interlocutor ` +
		"sent new message(s), shown above. Reconsider against them: call manager_reply " +
		"to send — resend the same text as-is if it still fits, or revise it (set " +
		"reply_to to the message you answer) — or manager_silent to drop it.]"
	);
}

/**
 * Correction injected after a turn that ended with plain text and no tool call.
 * Plain text is discarded and never reaches Telegram, so the reply was lost; this
 * re-prompt forces the model to end via a tool. Only used once per batch — if the
 * next turn is prose again, {@link ManagerController.onAgentEnd} delivers the text
 * verbatim rather than dropping it a second time.
 */
export const PROSE_CORRECTION =
	"[Your previous turn was plain text, which is NEVER delivered to Telegram — it " +
	"was discarded. You MUST end this turn by calling exactly ONE tool: manager_reply " +
	"(put the message in its `text` argument) or manager_silent. Do not write prose.]";

/**
 * Nudge added when the latest interlocutor message contains a configured
 * wake-word: it fast-tracked the message here, but only a genuine question to the
 * bot warrants a reply — a word used in passing does not.
 */
export const MENTION_HINT =
	"[A wake-word for you appears in the latest message. Reply ONLY if it is a " +
	"direct question or request addressed to you; if the word is just mentioned in " +
	"passing (describing something, not asking you), stay silent.]";

/** System block for an idle memory-consolidation turn (no reply is sent). */
export const CONSOLIDATION_INSTRUCTIONS =
	"You are reviewing a finished Telegram conversation to update your private " +
	"long-term memory about this specific person. Do NOT reply to anyone — nothing " +
	"you write reaches Telegram. Work strictly about the interlocutor, never the " +
	"owner or the bot. Answer only the numbered interrogation step shown below.";

/** Bare prompt that kicks off each interrogation probe (real directive is in context). */
const CONSOLIDATION_PROMPT =
	"Consolidate your long-term memory about this contact by answering the " +
	"interrogation step shown, calling exactly the one tool it names.";

/**
 * How each fact kind is surfaced in the "Known facts" block — a section title
 * plus the behaviour it should steer, so a fact does work rather than being a
 * flat note. Rendered in this order; untagged facts fall under `context`.
 */
const KIND_SECTIONS: Record<FactKind, { title: string; directive: string }> = {
	identity: {
		title: "Who they are",
		directive:
			"Ground your replies in these; address them correctly and never re-ask what you already know.",
	},
	preference: {
		title: "Preferences",
		directive: "Adapt your tone, format, and language to these.",
	},
	agreement: {
		title: "Agreements",
		directive:
			"These are commitments — honour them and proactively follow up on them.",
	},
	context: {
		title: "Context",
		directive:
			"Background that may be out of date — do not assume it still holds.",
	},
};

const KIND_ORDER: readonly FactKind[] = [
	"identity",
	"preference",
	"agreement",
	"context",
];

/** What a finished manager turn decided, for the owner-side debug feed. */
export type ManagerTurnOutcome = "reply" | "silent" | "held" | "corrected";

/**
 * A compact record of a single manager turn's outcome, returned by
 * {@link ManagerController.onAgentEnd} so the caller can mirror the model's
 * decision (and, at the index layer, its thinking + tool calls) to the owner.
 */
export interface ManagerTurnLog {
	chatId: string;
	contactName: string;
	outcome: ManagerTurnOutcome;
	/** The message category the model assigned, when it called a tool. */
	category?: string;
	/** Reply text (reply/held/corrected outcomes) or the silent reason. */
	text?: string;
	/** The Telegram message id a delivered reply threaded to. */
	replyToMessageId?: number;
}

export interface ManagerControllerDeps {
	subMode: ManagerSubMode;
	/** Assembled system-instruction blocks injected at the top of the context. */
	instructions: ManagerInstructions;
	labeler: string;
	/** Case-insensitive wake-words that fast-track a message past the owner window. */
	mentionWords: string[];
	rememberMessages: number;
	continueWindowMs: number;
	ownerReplyWindowMs: number;
	/** Last-N durable facts kept + injected per contact. */
	factsLimit: number;
	/** Quiet period (ms) before an idle memory-consolidation pass may run. */
	factConsolidationQuietMs: number;
	/**
	 * Silence (ms) after which a resuming chat is treated as a re-opening and gets
	 * the re-greeting instructions. `0` disables re-greeting.
	 */
	reopenAfterMs: number;
	/**
	 * How many times a drafted reply is re-considered when new interlocutor
	 * messages keep landing mid-turn before it is sent as-is. Caps the revise loop
	 * so a rapid sender cannot defer the reply forever; `0` sends immediately with
	 * no re-read.
	 */
	reviseThreshold: number;
	/** The Owner's display name, for self-introduction on first contact (optional). */
	ownerName?: string;
	/**
	 * Drop a reply the model marked as chatter/acknowledgement or not needing an
	 * answer unless the interlocutor addressed the bot directly. Curbs a weak model
	 * that over-replies to banter.
	 */
	strictReplyGuard: boolean;
	/** Max candidates individually verified in the consolidation interrogation. */
	verifyLimit: number;
	/**
	 * Max true age (ms) for an interlocutor message to open a live reply cycle. An
	 * older (redelivered/backlog) message is recorded for context only, so a
	 * conversation that ended long ago does not "wake" the manager on restart.
	 */
	liveFreshnessMs: number;
	/** IANA timezone for the `[Now: …]` line; undefined → system zone. */
	timezone?: string;
	/** Byte cap for describing/downloading inbound attachments. */
	maxBytes: number;
	/** Which inbound media reaches the model (images vision / documents). */
	media: ManagerMediaPolicy;
	clock: Clock;
	chatStore: ChatStore;
	contactStore: ContactStore;
	consolidationQueue: ConsolidationQueue;
	sentRegistry: SentRegistry;
	businessStore: BusinessStore;
	/** Whether the agent is free to take a new turn. */
	isIdle: () => boolean;
	/** Download an interlocutor message's inline images (empty when none/disabled). */
	loadImages?: (message: Message) => Promise<IsolatedImage[]>;
	/** Start an agent turn for the active chat (the prompt is a bare trigger). */
	triggerAgent: (prompt: string) => Promise<void>;
	/**
	 * Send a reply on behalf of the owner through the rich pipeline; returns the
	 * sent message id(s) (a long reply may split into several). `replyToMessageId`
	 * threads the reply to a specific message so the chat shows what is answered.
	 */
	sendReply: (args: {
		connectionId: string;
		chatId: string;
		text: string;
		replyToMessageId?: number;
	}) => Promise<number[]>;
	/** Show the typing indicator on a business chat. */
	typing: (args: { connectionId: string; chatId: string }) => Promise<void>;
}

interface ChatMeta {
	connectionId: string;
	contactName: string;
	/** The interlocutor's Telegram user id — where durable facts are stored. */
	userId?: string;
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

/**
 * Pick the message a reply threads to (Telegram `reply_parameters.message_id`):
 * the model's requested `[#id]` when it is a real inbound message in this chat,
 * otherwise the latest interlocutor message — so a reply is always visibly
 * attached to what it answers. Undefined when there is nothing to thread to.
 */
function resolveReplyTarget(
	records: readonly ChatMessageRecord[],
	requested: number | undefined,
): number | undefined {
	if (
		requested !== undefined &&
		records.some((r) => r.messageId === requested && r.author !== "bot")
	) {
		return requested;
	}
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		if (record.author === "interlocutor" && record.messageId !== undefined) {
			return record.messageId;
		}
	}
	return undefined;
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
	private readonly facts = new FactState();
	private readonly probes = new ProbeState();
	private readonly chats = new Map<string, ChatMeta>();
	/** Chats with an interlocutor message the model has not answered yet. */
	private readonly unserved = new Set<string>();
	/** Freshest downloaded images per chat (in-memory, newest turn only). */
	private readonly latestImages = new Map<string, IsolatedImage[]>();
	/**
	 * Chats that received a new interlocutor message WHILE their turn was already
	 * running (mid-inference). On turn end such a chat is not marked served and its
	 * reply is not sent blind — instead the model reconsiders against the newer
	 * messages, so nothing that arrived during generation is skipped.
	 */
	private readonly dirtyDuringTurn = new Set<string>();
	/**
	 * A reply the model drafted but that we held back because new messages landed
	 * mid-turn. Surfaced to the model next turn so it can resend as-is or revise.
	 */
	private readonly pendingReply = new Map<
		string,
		{ text: string; replyTo?: number }
	>();
	/**
	 * How many times the active draft for a chat has already been re-considered
	 * because new messages kept arriving. Once it reaches `reviseThreshold` the
	 * draft is sent as-is, so a rapid sender cannot defer the reply indefinitely.
	 */
	private readonly reviseCount = new Map<string, number>();
	/**
	 * Chats whose current turn ended in plain text and were already re-prompted
	 * once to call a tool. A second prose turn is delivered verbatim instead of
	 * being dropped, so a reply is never silently lost.
	 */
	private readonly proseRetried = new Set<string>();
	/**
	 * A one-shot trailing directive for the active chat's next turn (e.g. the
	 * plain-text correction). Consumed by {@link buildContextForActive} and cleared
	 * when the chat is served.
	 */
	private readonly correction = new Map<string, string>();
	/**
	 * The chat currently being memory-consolidated (idle pass), if any, together
	 * with the interrogation state machine driving its per-probe questions.
	 */
	private consolidating: {
		chatId: string;
		userId?: string;
		loop: InterrogationState;
	} | null = null;

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

	/** The per-turn fact sink the memory tool writes into. */
	factSink(): FactState {
		return this.facts;
	}

	/** The per-probe sink the interrogation tools write into (consolidation). */
	probeSink(): ProbeState {
		return this.probes;
	}

	/**
	 * Whether the model has made this turn's terminal decision, so the agent loop
	 * can stop re-sampling instead of spinning on identical context. Terminality is
	 * turn-type specific: a normal turn ends on reply/silent (a bare
	 * manager_remember does NOT end it — the model may still reply); a consolidation
	 * probe ends as soon as its interrogation tool has been called.
	 */
	turnDecided(): boolean {
		if (this.consolidating) {
			return this.probes.current() !== null;
		}
		return this.decision.current().kind !== "none";
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
			await this.touchConsolidation(chatId, messageTime);
			// Observer only: an explicit wake-word from the owner summons the bot even
			// though it normally never acts on owner messages. In takeover the owner
			// being present always freezes the chat (they are at the wheel), so the
			// wake-word is ignored for the owner there. A stale/backlog message never
			// wakes.
			if (
				this.deps.subMode === "observer" &&
				now - messageTime <= this.deps.liveFreshnessMs &&
				matchesMention(text, this.deps.mentionWords)
			) {
				const existing = this.chats.get(chatId);
				this.chats.set(chatId, {
					connectionId: input.connectionId,
					contactName: existing?.contactName ?? chatId,
					userId: existing?.userId,
				});
				this.unserved.add(chatId);
				this.scheduler.onMessage(chatId);
				return;
			}
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
		this.chats.set(chatId, {
			connectionId: input.connectionId,
			contactName,
			userId: from ? String(from.id) : undefined,
		});
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
		await this.touchConsolidation(chatId, messageTime);
		// A backlog message — one whose true send time is well in the past, e.g.
		// redelivered after downtime — is kept for context and consolidation but does
		// NOT open a live reply cycle; otherwise a conversation that ended long ago
		// would "wake" the manager on restart. Catch-up on activation
		// (selectCatchUpChats), which reasons off true timestamps, decides which
		// stale chats are still worth answering.
		if (now - messageTime > this.deps.liveFreshnessMs) return;
		this.unserved.add(chatId);
		// Landed while this chat's turn was mid-flight: flag it so turn end reconsiders
		// against this newer message instead of sending a now-stale reply blind.
		if (this.scheduler.activeChat() === chatId && !this.deps.isIdle()) {
			this.dirtyDuringTurn.add(chatId);
		}
		if (this.scheduler.activeChat() === chatId) {
			// A continuation of the active chat: cancel its continuation-release so it
			// stays active; it will be served on the next tick. No 5-min wait.
			this.scheduler.onMessage(chatId);
		} else if (matchesMention(text, this.deps.mentionWords)) {
			// A wake-word: skip the owner-reply window and make the chat ready now. The
			// scheduler still applies who-first / never-replied priority; the model
			// still decides whether the message is actually a question worth answering.
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

	/**
	 * Resolve the finished turn's decision and deliver a reply if the model chose
	 * to. `finalText` is the turn's trailing assistant prose (if any), used only to
	 * recover a reply the model wrote as plain text instead of calling a tool.
	 *
	 * Returns a compact log of what the turn decided (for the owner-side debug
	 * feed), or null when there is nothing to report (idle slot or a consolidation
	 * probe, neither of which is a chat-facing decision).
	 */
	async onAgentEnd(finalText?: string): Promise<ManagerTurnLog | null> {
		// A consolidation probe finished — advance the interrogation (no reply sent).
		if (this.consolidating) {
			await this.advanceConsolidation();
			return null;
		}
		const active = this.scheduler.activeChat();
		if (active === null) {
			this.facts.reset();
			return null;
		}
		const decision = this.decision.current();
		let text = resolveDecision(decision);
		let requestedReplyTo =
			decision.kind === "reply" ? decision.replyTo : undefined;
		// Capture the decision's descriptive fields before the reset clears them.
		const decisionKind = decision.kind;
		const category =
			decision.kind === "reply" || decision.kind === "silent"
				? decision.category
				: undefined;
		const silentReason =
			decision.kind === "silent" ? decision.reason : undefined;
		const needsReply =
			decision.kind === "reply" || decision.kind === "silent"
				? decision.needsReply
				: undefined;
		this.decision.reset();
		const meta = this.chats.get(active);
		const contactName = meta?.contactName ?? active;
		// Persist any durable facts the model recorded mid-conversation.
		await this.persistRecordedFacts(meta?.userId, meta?.contactName);
		this.gate.clearServed(active);
		// The model ended in plain text without calling a tool. Plain text is never
		// delivered, so the reply was lost. Re-prompt once to make it call a tool; if
		// it writes prose again, deliver the text verbatim rather than dropping it.
		const prose = finalText?.trim();
		if (decisionKind === "none" && prose) {
			if (!this.proseRetried.has(active)) {
				this.proseRetried.add(active);
				this.correction.set(active, PROSE_CORRECTION);
				await this.triggerTurn();
				return {
					chatId: active,
					contactName,
					outcome: "corrected",
					text: prose,
				};
			}
			text = prose;
			requestedReplyTo = undefined;
		}
		// New interlocutor message(s) arrived while this turn was generating: don't
		// send the now-stale draft blind. Hold it, keep the chat unserved, and let the
		// model reconsider next turn against the newer messages (revise or resend) —
		// but only up to reviseThreshold times, so a rapid sender cannot defer the
		// reply forever; past the cap the draft is sent as-is.
		const arrivedMidTurn = this.dirtyDuringTurn.delete(active);
		if (text && arrivedMidTurn) {
			const cycles = this.reviseCount.get(active) ?? 0;
			if (cycles < this.deps.reviseThreshold) {
				this.reviseCount.set(active, cycles + 1);
				this.pendingReply.set(active, { text, replyTo: requestedReplyTo });
				await this.triggerTurn();
				return { chatId: active, contactName, outcome: "held", text, category };
			}
		}
		// The turn settled — this chat is served, whatever the model decided.
		this.unserved.delete(active);
		this.latestImages.delete(active);
		this.pendingReply.delete(active);
		this.reviseCount.delete(active);
		this.proseRetried.delete(active);
		this.correction.delete(active);
		let deliveredReplyTo: number | undefined;
		let guardReason: string | undefined;
		if (text) {
			const records = meta
				? await this.deps.chatStore.getRecent(
						active,
						this.deps.rememberMessages,
					)
				: [];
			// Strict guard against a weak model over-replying to banter: unless the
			// interlocutor addressed the bot directly (by category or a wake-word),
			// drop a reply the model itself tagged as chatter/acknowledgement or as
			// not needing an answer.
			if (this.deps.strictReplyGuard && decisionKind === "reply") {
				const lastInterlocutor = [...records]
					.reverse()
					.find((record) => record.author === "interlocutor");
				const addressed =
					category === "addressed_to_bot" ||
					(lastInterlocutor !== undefined &&
						matchesMention(lastInterlocutor.text, this.deps.mentionWords));
				const lowValue =
					category === "chatter" ||
					category === "acknowledgement" ||
					needsReply === false;
				if (!addressed && lowValue) {
					guardReason = `guard: dropped a ${category ?? "reply"} not addressed to you`;
					text = null;
				}
			}
			if (text && meta) {
				deliveredReplyTo = resolveReplyTarget(records, requestedReplyTo);
				// Pass the raw reply text; the send layer applies the labeler, the bot
				// marker, and the business-safe classic-HTML formatting.
				const ids = await this.deps.sendReply({
					connectionId: meta.connectionId,
					chatId: active,
					text,
					replyToMessageId: deliveredReplyTo,
				});
				// A long reply can split into several messages; record every id so the
				// bot recognises each as its own echo, and keep the first for the record.
				for (const id of ids)
					await this.deps.sentRegistry.recordSent(active, id);
				const now = this.deps.clock.now();
				await this.deps.chatStore.append(active, {
					author: "bot",
					text,
					timestamp: now,
					messageId: ids[0],
				});
				await this.touchConsolidation(active, now);
			}
		}
		if (text) {
			// Replied: keep the chat active and arm the 1:30 continuation window.
			this.scheduler.onReplied();
		} else {
			// Silent (or guard-dropped): release the chat and promote the next.
			this.scheduler.next();
		}
		await this.triggerTurn();
		return text
			? {
					chatId: active,
					contactName,
					outcome: "reply",
					text,
					category,
					replyToMessageId: deliveredReplyTo,
				}
			: {
					chatId: active,
					contactName,
					outcome: "silent",
					text: silentReason ?? guardReason,
					category,
				};
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
		const started = await this.triggerTurn();
		// Only consolidate memory in the idle gaps — never ahead of a reply.
		if (!started) await this.maybeStartConsolidation();
	}

	/**
	 * Rebuild the full message array the model sees for the active chat, or null
	 * when idle. Structure: the injected system-instruction block (rules, plus a
	 * one-line state summary so the model decides deliberately), then the isolated
	 * chat history (with the freshest interlocutor image attached), then a final
	 * action directive.
	 */
	async buildContextForActive(): Promise<IsolatedMessage[] | null> {
		if (this.consolidating) return this.buildConsolidationContext();
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
		const state = analyzeChat(records);
		// First contact = no bot reply yet and at most this one interlocutor line.
		const isFirstMessage =
			!records.some((record) => record.author === "bot") &&
			records.filter((record) => record.author === "interlocutor").length <= 1;
		// A re-opening = not first contact, but the latest message follows a long gap
		// (from anyone's previous message). reopenAfterMs === 0 disables this.
		const opener = isFirstMessage
			? this.deps.instructions.firstMessage
			: this.isReopening(records)
				? this.deps.instructions.reopen
				: "";
		const known = await this.knownFactsBlock(meta);
		const ownerName = this.deps.ownerName?.trim();
		const ownerLine = ownerName
			? `\n\nThe account Owner's name is ${ownerName}. When you introduce ` +
				`yourself, say you are ${ownerName}'s assistant.`
			: "";
		// The instruction prefix stays stable across a chat's turns (so the provider
		// caches it); the volatile bits — the clock, the per-message state line, and
		// the action directive — live in a single trailing message.
		const system =
			`${SYSTEM_INSTRUCTIONS_HEADER}\n\n${this.deps.instructions.base}` +
			ownerLine +
			(opener ? `\n\n${opener}` : "") +
			(known ? `\n\n${known}` : "");
		const pending = this.pendingReply.get(active);
		const correction = this.correction.get(active);
		const directive = this.turnDecided()
			? MANAGER_TURN_DONE
			: correction
				? correction
				: pending
					? reviseDirective(pending.text)
					: MANAGER_ACTION_TRIGGER;
		// Flag a wake-word in the latest interlocutor line so the model weighs whether
		// it is really addressed vs. the word just being mentioned.
		const lastInterlocutor = [...records]
			.reverse()
			.find((record) => record.author === "interlocutor");
		const mentionHint =
			lastInterlocutor &&
			matchesMention(lastInterlocutor.text, this.deps.mentionWords)
				? `\n\n${MENTION_HINT}`
				: "";
		return [
			{ role: "user", content: system },
			...isolated,
			{
				role: "user",
				content: `${this.nowLine()}\n\n${stateSummary(state)}${mentionHint}\n\n${directive}`,
			},
		];
	}

	/**
	 * Build the isolated context for the current consolidation probe: the shared
	 * consolidation system block, the isolated transcript, then the directive for
	 * the interrogation's current step (identify → candidates → per-fact verify).
	 * Once the probe's tool has been called, the done directive ends the turn.
	 */
	private async buildConsolidationContext(): Promise<IsolatedMessage[]> {
		const current = this.consolidating as {
			chatId: string;
			loop: InterrogationState;
		};
		const records = await this.deps.chatStore.getRecent(
			current.chatId,
			this.deps.rememberMessages,
		);
		const meta = this.chats.get(current.chatId);
		const isolated = buildIsolatedMessages({
			records,
			boundary: boundaryDirective(meta?.contactName ?? current.chatId),
		});
		const known = await this.knownFactsBlock(meta);
		const system =
			`${SYSTEM_INSTRUCTIONS_HEADER}\n\n${CONSOLIDATION_INSTRUCTIONS}` +
			(known ? `\n\n${known}` : "");
		const directive = this.turnDecided()
			? MANAGER_TURN_DONE
			: currentProbe(current.loop).directive;
		return [
			{ role: "user", content: system },
			...isolated,
			{ role: "user", content: `${this.nowLine()}\n\n${directive}` },
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
	private async triggerTurn(): Promise<boolean> {
		if (!this.deps.isIdle() || this.consolidating) return false;
		while (
			this.scheduler.activeChat() !== null &&
			!this.unserved.has(this.scheduler.activeChat() as string) &&
			this.scheduler.continuationRemaining() === null
		) {
			this.scheduler.next();
		}
		const active = this.scheduler.activeChat();
		if (active === null || !this.unserved.has(active)) return false;
		this.decision.reset();
		this.facts.reset();
		// Fresh turn: only messages that arrive AFTER this point count as mid-turn
		// arrivals that should trigger a reconsider.
		this.dirtyDuringTurn.delete(active);
		const meta = this.chats.get(active);
		if (meta) {
			await this.deps
				.typing({ connectionId: meta.connectionId, chatId: active })
				.catch(() => {});
		}
		await this.deps.triggerAgent(
			"Respond to the latest messages in the active Telegram chat by calling manager_reply or manager_silent.",
		);
		return true;
	}

	/**
	 * Whether the active chat's latest message resumes the conversation after a
	 * long silence — a gap larger than `reopenAfterMs` from the previous message
	 * (of any author). Disabled when `reopenAfterMs` is 0 or there is no prior
	 * message to measure the gap against.
	 */
	private isReopening(records: readonly ChatMessageRecord[]): boolean {
		if (this.deps.reopenAfterMs <= 0 || records.length < 2) return false;
		const last = records[records.length - 1];
		const prev = records[records.length - 2];
		return last.timestamp - prev.timestamp > this.deps.reopenAfterMs;
	}

	/** The `[Now: …]` line injected into every context. */
	private nowLine(): string {
		return formatNowLine(this.deps.clock.now(), this.deps.timezone);
	}

	/**
	 * A "Known facts about X" block for a chat's contact, grouped into sections by
	 * kind — each section leads with the behaviour that kind should steer, so the
	 * model uses an identity fact differently from a preference or an agreement.
	 * Returns "" when there is nothing to show.
	 */
	private async knownFactsBlock(meta: ChatMeta | undefined): Promise<string> {
		if (!meta?.userId) return "";
		const facts = await this.deps.contactStore.getFacts(meta.userId);
		if (facts.length === 0) return "";
		const recent = facts.slice(-this.deps.factsLimit);
		const byKind = new Map<FactKind, string[]>();
		for (const fact of recent) {
			const kind = fact.kind ?? "context";
			const bucket = byKind.get(kind) ?? [];
			bucket.push(fact.text);
			byKind.set(kind, bucket);
		}
		const sections: string[] = [];
		for (const kind of KIND_ORDER) {
			const items = byKind.get(kind);
			if (!items?.length) continue;
			const { title, directive } = KIND_SECTIONS[kind];
			const lines = items.map((text) => `- ${text}`).join("\n");
			sections.push(`${title} (${directive})\n${lines}`);
		}
		return `Known facts about ${meta.contactName}:\n\n${sections.join("\n\n")}`;
	}

	/**
	 * Persist the facts the model recorded this turn (capped to factsLimit), behind
	 * the who-is-who firewall: only facts the model tagged `subject: interlocutor`
	 * are kept, and nothing is written if the target card is actually the business
	 * owner (a self-test where the owner messaged their own bot). Each stored fact
	 * carries the confirmed contact name + kind for auditability.
	 */
	private async persistRecordedFacts(
		userId: string | undefined,
		contactName?: string,
	): Promise<void> {
		const recorded = this.facts.current();
		this.facts.reset();
		if (!userId || recorded.length === 0) return;
		if (await this.isOwnerUserId(userId)) return;
		const kept = recorded.filter((fact) => fact.subject === "interlocutor");
		if (kept.length === 0) return;
		const now = this.deps.clock.now();
		const facts: ContactFact[] = kept.map((fact) => ({
			text: fact.text,
			timestamp: now,
			source: "manager",
			subject: contactName,
			kind: fact.kind,
		}));
		await this.deps.contactStore.appendFacts(
			userId,
			facts,
			this.deps.factsLimit,
		);
	}

	/** Whether a userId is the business owner (never store contact facts for them). */
	private async isOwnerUserId(userId: string): Promise<boolean> {
		const connections = await this.deps.businessStore.all();
		return connections.some((connection) => connection.userId === userId);
	}

	/** Mark a chat as a consolidation candidate, refreshing its quiet timer. */
	private async touchConsolidation(
		chatId: string,
		activityAt: number,
	): Promise<void> {
		const userId = this.chats.get(chatId)?.userId;
		if (!userId) return; // nothing to remember without a known contact
		await this.deps.consolidationQueue.upsert({ chatId, userId, activityAt });
	}

	/**
	 * When fully idle (nothing to answer, no active turn), pop an eligible chat
	 * (quiet long enough) and run a memory-consolidation turn for it. Never
	 * pre-empts a reply — the caller only invokes this when no turn was started.
	 */
	private async maybeStartConsolidation(): Promise<void> {
		if (!this.deps.isIdle() || this.consolidating) return;
		if (this.scheduler.activeChat() !== null || this.unserved.size > 0) return;
		const entry = await this.deps.consolidationQueue.eligible(
			this.deps.clock.now(),
			this.deps.factConsolidationQuietMs,
		);
		if (!entry) return;
		const contactName =
			this.chats.get(entry.chatId)?.contactName ?? entry.chatId;
		this.consolidating = {
			chatId: entry.chatId,
			userId: entry.userId,
			loop: initInterrogation(contactName),
		};
		this.facts.reset();
		this.probes.reset();
		await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
	}

	/**
	 * Advance the interrogation by one probe. Reads the tool result recorded this
	 * turn, steps the state machine, then either triggers the next probe or — when
	 * the interrogation is done — persists the confirmed facts (through the same
	 * who-is-who firewall) and drops the chat from the consolidation queue.
	 */
	private async advanceConsolidation(): Promise<void> {
		const current = this.consolidating;
		if (!current) return;
		const records = await this.deps.chatStore.getRecent(
			current.chatId,
			this.deps.rememberMessages,
		);
		const interlocutorLines = records
			.filter((record) => record.author === "interlocutor")
			.map((record) => record.text);
		const next = advanceInterrogation(
			current.loop,
			this.probes.current(),
			interlocutorLines,
			this.deps.verifyLimit,
		);
		this.probes.reset();
		if (!isDone(next)) {
			this.consolidating = { ...current, loop: next };
			await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
			return;
		}
		// Interrogation finished: persist the confirmed facts through the firewall.
		this.consolidating = null;
		this.facts.reset();
		for (const fact of finalFacts(next)) {
			this.facts.record([
				{ text: fact.text, subject: "interlocutor", kind: fact.kind },
			]);
		}
		const contactName = this.chats.get(current.chatId)?.contactName;
		await this.persistRecordedFacts(current.userId, contactName);
		await this.deps.consolidationQueue.remove(current.chatId);
	}
}
