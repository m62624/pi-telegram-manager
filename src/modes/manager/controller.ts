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
 *    first, plus a `continueWindowMs` (2:00) continuation window from the bot's
 *    reply that keeps a chat active while the conversation is live.
 *
 * A chat is only handed a turn while it has an unanswered interlocutor message
 * (`unserved`), so the agent never spins on an already-answered chat. On turn end
 * the model's `telegram_manager_reply` text is delivered on behalf of the owner (tagged so
 * the bot never mistakes its own send for the owner); `telegram_manager_silent` releases
 * the chat to the next in line.
 *
 * Every Pi/grammY specific arrives as a port, so the coordination is unit-testable
 * with fakes; `index.ts` wires the ports to the live runtime.
 */
import type { BusinessConnection, Message } from "@grammyjs/types";
import { formatNowLine } from "../../core/datetime";
import {
	DEFAULT_FORWARD_POLICY,
	ForwardBursts,
	type ForwardPolicy,
	forwardLimitNote,
	limitForwardText,
} from "../../core/forwards";
import type { Clock } from "../../core/timers";
import { buildContextLines } from "../../core/turns";
import {
	type ManagerInstructions,
	SYSTEM_INSTRUCTIONS_HEADER,
} from "../../instructions/builtin";
import type { BusinessStore } from "../../storage/business-store";
import type {
	ChatCursorStore,
	ConsolidationQueue,
	SentRegistry,
} from "../../storage/chat-state";
import type {
	ChatMessageRecord,
	ChatStore,
	StoredImageRef,
} from "../../storage/chat-store";
import { ownWords } from "../../storage/chat-store";
import type { ContactStore } from "../../storage/contact-store";
import {
	type ContactMemory,
	MEMORY_EPISODE_ENTITY,
	MEMORY_EPISODE_RELATION,
	type MemoryWorkspace,
} from "../../storage/memory";
import { describeAttachments, isImage } from "../../telegram/media";
import { extractMessageContext } from "../../telegram/message-context";
import { extractProfileFromUser } from "../../telegram/profile";
import {
	CONSOLIDATION_INSTRUCTIONS,
	CONSOLIDATION_PROMPT,
	type ConsolidationLimits,
	consolidationDirective,
	consolidationVerdict,
} from "./consolidation";
import {
	boundaryDirective,
	buildIsolatedMessages,
	type IsolatedImage,
	type IsolatedMessage,
	windowRecords,
} from "./context-isolation";
import { analyzeChat, conversationStateCard } from "./conversation-state";
import {
	DecisionState,
	DraftResolutionState,
	type MessageCategory,
	resolveDecision,
} from "./decision";
import { isBotMessage, stripBotMarker } from "./identity";
import {
	consolidationMemoryBlock,
	dropVisible,
	memoryBlock,
	recallQuery,
} from "./memory-block";
import { MemoryLedger, type MemoryToolContext } from "./memory-tools";
import { matchesMention } from "./mention";
import { ReplyGate } from "./reply-gate";
import { ChatScheduler } from "./scheduler";

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
	"one tool — telegram_manager_reply to answer, or telegram_manager_silent to stay quiet and keep " +
	"observing. " +
	"Never write plain text and never write a tool name as text. No draft is held " +
	"right now, so telegram_manager_resolve_draft does NOT apply this turn — calling it " +
	"fails.]";

/**
 * Replaces the action trigger once the turn's terminal decision is already
 * recorded. If the agent loop re-samples the model before the turn-end abort
 * lands — a race — this tells the model the decision is made so it ends the
 * turn instead of repeating the same tool call against otherwise-identical
 * context.
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
		`[HELD-DRAFT TURN. You drafted this reply: «${draft}». Since then new message(s) ` +
		"landed — from the interlocutor, or the Owner answering themselves — so it was " +
		"NOT sent yet. Read them above before you decide.\n" +
		"telegram_manager_reply and telegram_manager_silent are DISABLED this turn — calling either " +
		"fails and wastes the turn. The ONE tool that ends this turn is " +
		"telegram_manager_resolve_draft (it IS available, whatever you assume about your tool " +
		"list):\n" +
		'  telegram_manager_resolve_draft {"action": "send"} — deliver the draft unchanged;\n' +
		'  telegram_manager_resolve_draft {"action": "refine", "text": "<full final message>"} — ' +
		"deliver a rewrite that starts from the draft and folds in the new info;\n" +
		'  telegram_manager_resolve_draft {"action": "drop"} — ONLY if they retracted the ' +
		"question, answered it themselves, or the Owner has now answered it (or your " +
		"draft merely repeats what the Owner said).\n" +
		"A still-open question must be sent or refined — never dropped just because a " +
		"trailing message is small talk, and never merely because the Owner appeared.]"
	);
}

/**
 * Trailing directive when the previous turn ended in plain text: that prose was
 * almost certainly the reply, written the wrong way (plain text is never delivered
 * to Telegram). Rather than re-decide from scratch — where a weak model may relabel
 * a real question as chatter and the guard then drops the answer — the prose is held
 * as a draft and resolved through the same gate, so a composed answer is never
 * silently lost.
 */
export function proseResolveDirective(draft: string): string {
	return (
		"[HELD-DRAFT TURN. Your previous turn was plain text, which is NEVER delivered " +
		`to Telegram: «${draft}». That was almost certainly your reply, written the ` +
		"wrong way — it has NOT been sent to the chat. It is not lost: it is held as a " +
		"draft, and this turn decides what happens to it. It is a reply to the active " +
		"chat — do not re-analyse who it is for or open a fresh decision; this turn is " +
		"only send / refine / drop.\n" +
		"telegram_manager_reply and telegram_manager_silent are DISABLED this turn — calling either fails " +
		"and wastes the turn. The ONE tool that ends this turn is telegram_manager_resolve_draft " +
		"(it IS available, whatever you assume about your tool list):\n" +
		'  telegram_manager_resolve_draft {"action": "send"} — deliver that text as-is (usually ' +
		"the right call);\n" +
		'  telegram_manager_resolve_draft {"action": "refine", "text": "<full final message>"} — ' +
		"deliver a corrected version of it;\n" +
		'  telegram_manager_resolve_draft {"action": "drop"} — ONLY if it was not meant as a ' +
		"message to the interlocutor (e.g. it was just your own reasoning).\n" +
		"A real question deserves its answer — do not drop it as chatter.]"
	);
}

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
	/** The interlocutor's @username, when known. */
	username?: string;
	/** The interlocutor's phone, only when they shared their contact card. */
	phone?: string;
	/** The interlocutor's Telegram user id, when known. */
	userId?: string;
	/** Telegram language code of the interlocutor, when known. */
	languageCode?: string;
	/** Whether the interlocutor has Telegram Premium, when known. */
	isPremium?: boolean;
	/** Whether the interlocutor is a bot, when known. */
	isBot?: boolean;
	outcome: ManagerTurnOutcome;
	/** The message category the model assigned, when it called a tool. */
	category?: string;
	/** Reply text (reply/held/corrected outcomes) or the silent reason. */
	text?: string;
	/** The Telegram message id a delivered reply threaded to. */
	replyToMessageId?: number;
	/** The interlocutor's latest message — where a log card's message link points. */
	lastMessageId?: number;
}

export interface ManagerControllerDeps {
	/** Assembled system-instruction blocks injected at the top of the context. */
	instructions: ManagerInstructions;
	labeler: string;
	/** Case-insensitive wake-words that fast-track a message past the owner window. */
	mentionWords: string[];
	rememberMessages: number;
	continueWindowMs: number;
	ownerReplyWindowMs: number;
	/**
	 * Character budget for the transcript window the model reads: `maxCharsPerMessage`
	 * truncates one over-long message, `maxContextChars` drops the oldest until the
	 * window fits. Either <= 0 disables that cap. Applied over the rememberMessages
	 * window; disk transcripts are untouched.
	 */
	maxCharsPerMessage: number;
	maxContextChars: number;
	/**
	 * Budget for FORWARDED messages, applied when they land — a stranger pasting a
	 * batch of other people's posts must not be able to fill the context by itself.
	 * Defaults to {@link DEFAULT_FORWARD_POLICY}.
	 */
	forwards?: ForwardPolicy;
	/** Quiet period (ms) before an idle memory-consolidation pass may run. */
	factConsolidationQuietMs: number;
	/**
	 * How much of a turn's prompt one recall may spend, in tokens.
	 *
	 * The successor to the old `factsLimit`, and a different KIND of limit: that one
	 * bounded how much could be remembered, so learning something meant forgetting
	 * something. This bounds only how much of what is remembered may be said in one
	 * turn — and it is charged in the trailing block, so it costs its own tokens and
	 * nothing above it.
	 */
	recallTokenBudget: number;
	/** Max facts one recall may select; 0 = the engine's default. */
	recallK: number;
	/** Bounds on an idle memory pass — see `consolidation.ts`. */
	consolidationLimits: ConsolidationLimits;
	/** Record inbound messages and turn outcomes as episodes alongside the facts. */
	episodes: boolean;
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
	/**
	 * The account owner's Telegram user id (`allowedUserId`), as a string. Used to tell
	 * the owner's own messages from an interlocutor's when the business connection is
	 * not (yet) in the store — see `onBusinessMessage`.
	 */
	ownerUserId?: string;
	/** The Owner's display name, for self-introduction on first contact (optional). */
	ownerName?: string;
	/**
	 * Drop a reply the model marked as chatter/acknowledgement or not needing an
	 * answer unless the interlocutor addressed the bot directly. Curbs a weak model
	 * that over-replies to banter.
	 */
	strictReplyGuard: boolean;
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
	/**
	 * Cap on images per turn — an album arrives as separate messages and accumulates
	 * for the chat's next turn. Falsy = no cap (Pi imposes none either; the cap exists
	 * to protect a small local context).
	 */
	maxImages?: number;
	/** Which inbound media reaches the model (images vision / documents). */
	media: ManagerMediaPolicy;
	clock: Clock;
	chatStore: ChatStore;
	/** Telegram profiles only — facts live in {@link ManagerControllerDeps.memory}. */
	contactStore: ContactStore;
	/** One database per contact; the controller is the only thing that picks which. */
	memory: MemoryWorkspace;
	consolidationQueue: ConsolidationQueue;
	/** How far each chat has been answered and consolidated — see `chat-state`. */
	chatCursors: ChatCursorStore;
	sentRegistry: SentRegistry;
	businessStore: BusinessStore;
	/**
	 * Report a memory that will not open — a database whose vector width no longer
	 * matches the configured embedder, a permissions problem, a corrupt file.
	 *
	 * Called at most once per distinct message. The manager keeps answering people
	 * without it, because refusing to answer a stranger over a broken file would be a
	 * worse failure than answering them without remembering who they are — but the
	 * owner is told, in words, rather than left with a bot that has quietly stopped
	 * learning.
	 */
	onMemoryError?: (message: string) => void;
	/** Whether the agent is free to take a new turn. */
	isIdle: () => boolean;
	/** Download an interlocutor message's inline images (empty when none/disabled). */
	loadImages?: (message: Message) => Promise<IsolatedImage[]>;
	/** Re-download persisted image references when rebuilding historical context. */
	loadImageRefs?: (refs: readonly StoredImageRef[]) => Promise<IsolatedImage[]>;
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
	/** Message id of their latest message — what a log card links you to. */
	lastMessageId?: number;
}

/**
 * Text a message carries — body, media caption, or, for a sticker (otherwise an
 * empty message), its base emoji so the model can read it like any other emoji.
 */
function messageText(message: Message): string {
	const base = message.text ?? message.caption ?? "";
	if (base) return base;
	if (message.sticker) {
		return message.sticker.emoji
			? `[sticker] ${message.sticker.emoji}`
			: "[sticker]";
	}
	return "";
}

function dedupeImageRefs(refs: readonly StoredImageRef[]): StoredImageRef[] {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		if (seen.has(ref.fileId)) return false;
		seen.add(ref.fileId);
		return true;
	});
}

/**
 * The cross-message context of a stored message (forward origin, reply, quote,
 * cross-chat reply), kept APART from the author's own words.
 *
 * It used to be prefixed onto the stored text. That merged someone else's words
 * into the speaker's line, and two things broke: the model read `Owner: [reply to
 * Alice]: "…"` as ALICE speaking, and the memory pass accepted a quote lifted from
 * a reply as proof of what the interlocutor had said about themselves.
 */
function messageContext(message: Message): string | undefined {
	const lines = buildContextLines(extractMessageContext(message));
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Which side pulled the bot into the current turn — and therefore whom a reply
 * answers. The owner summons with a wake-word; an interlocutor asks a question.
 * Both are `role: "user"` to the model (only the bot is `assistant`), so the
 * distinction lives in the stored {@link ChatAuthor}, never in the LLM role.
 */
export type TriggerSide = "owner" | "interlocutor";

/**
 * The message the current turn answers: the latest one from the trigger's own
 * side. When the owner summoned the bot, that is the owner's most recent line
 * (their wake-word/question), NOT some bystander's trailing sticker; when an
 * interlocutor asked, it is their latest line.
 */
export function triggerMessage(
	records: readonly ChatMessageRecord[],
	side: TriggerSide,
): ChatMessageRecord | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		if (records[i].author === side) return records[i];
	}
	return undefined;
}

/**
 * Pick the message a reply threads to (Telegram `reply_parameters.message_id`),
 * SCOPED to the side that triggered the turn. The model's requested `[#id]` is
 * honoured only when it is a real inbound message FROM THAT SIDE; otherwise the
 * reply threads to the latest message from that side. A reply therefore never
 * attaches to the other party — an owner-summoned answer cannot land on a
 * bystander's laugh, and an interlocutor's answer cannot land on the owner's
 * aside. Undefined when there is nothing on that side to thread to.
 */
function resolveReplyTarget(
	records: readonly ChatMessageRecord[],
	requested: number | undefined,
	side: TriggerSide,
): number | undefined {
	if (
		requested !== undefined &&
		records.some((r) => r.messageId === requested && r.author === side)
	) {
		return requested;
	}
	return triggerMessage(records, side)?.messageId;
}

/**
 * The trailing nudge that names WHO pulled the bot into this turn and which
 * message to thread the reply to — the same "here is who you answer" contract
 * the draft-resolution directive uses. It rides in the volatile trailing block,
 * never the cached head. A wake-word on the trigger message raises the pull
 * toward replying; without one, the bot still weighs whether an answer is owed.
 * Empty when there is no message from the trigger side to point at.
 *
 * Every branch states the EVIDENCE and leaves the verdict to the model, because
 * the verdict is the model's job. This used to be true of the interlocutor
 * branches only: the owner branch opened with "their message is addressed to
 * YOU", which is the very question the model was supposed to answer. Sitting one
 * line under "[State: the owner spoke last. Stay silent unless you are directly
 * addressed.]", it read as the resolution of that condition — addressed, so
 * answer — and the trailing "only stay silent if the wake-word was used in
 * passing" never got weighed. A pasted link whose path happened to contain the
 * wake-word was answered as if it had been a question.
 */
export function triggerHint(
	records: readonly ChatMessageRecord[],
	side: TriggerSide,
	mentionWords: readonly string[],
): string {
	const message = triggerMessage(records, side);
	if (!message) return "";
	const anchor =
		message.messageId !== undefined ? `[#${message.messageId}]` : "";
	const at = anchor ? ` ${anchor}` : "";
	if (side === "owner") {
		// The wake-word is in this very message: say so, and say what it is worth.
		if (matchesMention(message.text, mentionWords)) {
			return (
				`[The Owner used a wake-word for you in message${at} — that is what ` +
				`pulled you into this turn. It is evidence, not proof: the word can ` +
				`land in a link, a name, or a line ABOUT you rather than one TO you. ` +
				`Decide by meaning. If they are putting a question or request to you, ` +
				`you MUST answer the Owner and thread your reply to${at}, not to anyone ` +
				`else in the chat. Stay silent only when the word was incidental and ` +
				`nothing is asked of you.]`
			);
		}
		// A summons is open but this line does not carry the wake-word: the owner is
		// still adding to the request they put to the bot a moment ago.
		return (
			`[The Owner called you moments ago; message${at} is what they have added ` +
			`since. If their request now reads as complete, you MUST answer the Owner ` +
			`and thread your reply to${at}, not to anyone else in the chat. If they are ` +
			`still assembling it, stay silent.]`
		);
	}
	const who = message.senderName
		? `Interlocutor (${message.senderName})`
		: "The interlocutor";
	if (matchesMention(message.text, mentionWords)) {
		return (
			`[${who} used a wake-word for you in message${at} — very likely a direct ` +
			`question to you. Reply and thread it to${at}, unless the word is only ` +
			`mentioned in passing (describing something, not asking you), then stay silent.]`
		);
	}
	return (
		`[${who} is waiting on message${at}. If a reply is warranted, thread it ` +
		`to${at} — reply to THEM, not to anyone else in the chat.]`
	);
}

/** One idle memory pass over one chat, and everything it needs to resume. */
interface ConsolidationPass {
	chatId: string;
	userId?: string;
	/** The second queue: what the pass has done, and what stops it. */
	ledger: MemoryLedger;
	/**
	 * The newest message this pass can see. Written to the chat's cursor when the pass
	 * finishes, and it is what stops the same conversation being re-read from scratch
	 * at every launch.
	 */
	coveredThrough: number;
}

export class ManagerController {
	private readonly scheduler: ChatScheduler;
	private readonly gate: ReplyGate;
	private readonly decision = new DecisionState();
	private readonly resolve = new DraftResolutionState();
	/**
	 * The ledger `memoryToolContext().ledger()` falls back to when no pass is running.
	 *
	 * Every memory verb is now consolidation-pass-only (`tool-gate.ts`), backed by a
	 * runtime tool guard (`registerToolGuard` in `index.ts`) that refuses the call
	 * before `execute()` ever runs — so this fallback should be unreachable in
	 * practice. Kept anyway so `ledger()` never has to return `null`: a pure safety
	 * net against a gate regression, not a working path.
	 */
	private readonly scratchLedger = new MemoryLedger();
	/** Memory failures already announced — see {@link reportMemoryError}. */
	private readonly memoryErrorsSeen = new Set<string>();
	/** Contacts already joined to their episode log this run — see `recordEpisode`. */
	private readonly episodesLinked = new Set<string>();
	private readonly chats = new Map<string, ChatMeta>();
	/** Chats with an interlocutor message the model has not answered yet. */
	private readonly unserved = new Set<string>();
	/**
	 * Downloaded images awaiting the chat's next turn (in-memory, dropped once the
	 * turn runs). Telegram delivers an ALBUM as separate messages — one photo each —
	 * so they accumulate here and the model sees the whole album in one turn, not just
	 * whichever picture happened to land last. Capped, because a batch of pictures is
	 * the fastest way to blow a small local context.
	 */
	private readonly latestImages = new Map<string, IsolatedImage[]>();
	/** Historical image bytes cached by chat and Telegram message id for this process. */
	private readonly historicalImages = new Map<
		string,
		Map<number, IsolatedImage[]>
	>();
	/**
	 * Chats that received a new interlocutor message WHILE their turn was already
	 * running (mid-inference). On turn end such a chat is not marked served and its
	 * reply is not sent blind — instead the model reconsiders against the newer
	 * messages, so nothing that arrived during generation is skipped.
	 */
	private readonly dirtyDuringTurn = new Set<string>();
	/**
	 * Chats the OWNER summoned the bot into with a wake-word, and whose turn has not
	 * run yet. Until it does, further owner messages are part of
	 * the request being assembled — not the owner handling the chat themselves — so
	 * they must not cancel it. Cleared when the turn settles.
	 */
	private readonly ownerSummoned = new Set<string>();
	/**
	 * A reply the model drafted but that we held back because new messages landed
	 * mid-turn. Surfaced to the model next turn so it can resend as-is or revise.
	 */
	private readonly pendingReply = new Map<
		string,
		{ text: string; replyTo?: number; fromProse?: boolean }
	>();
	/**
	 * How many times the active draft for a chat has already been re-considered
	 * because new messages kept arriving. Once it reaches `reviseThreshold` the
	 * draft is sent as-is, so a rapid sender cannot defer the reply indefinitely.
	 */
	private readonly reviseCount = new Map<string, number>();
	/**
	 * The chat currently being memory-consolidated (idle pass), if any, with the
	 * ledger of what the pass has done — see `consolidation.ts`.
	 */
	private consolidating: ConsolidationPass | null = null;
	/**
	 * A consolidation paused because live conversation work appeared. The ledger goes
	 * with it, so a resumed pass knows what it already did and does not redo it, and
	 * {@link maybeStartConsolidation} picks it up once the manager is idle again.
	 * Distinct from {@link consolidating} so a live turn's termination is judged on the
	 * reply decision rather than on a memory pass's state.
	 */
	private pausedConsolidation: ConsolidationPass | null = null;
	/**
	 * The recall block for the turn in flight, and the batch it was fetched for.
	 *
	 * `pi.on("context")` runs before EVERY sample, and within one run the trailing
	 * message must be the same bytes each time — otherwise a re-sample after a tool
	 * call re-reads a block that says the same thing in a different order. Keyed by
	 * the query so a genuinely new batch invalidates it.
	 */
	private recallCache: { chatId: string; query: string; block: string } | null =
		null;
	/** Open forward batches, per chat — the budget for pasted-in content. */
	private readonly forwards: ForwardBursts;

	private get forwardPolicy(): ForwardPolicy {
		return this.deps.forwards ?? DEFAULT_FORWARD_POLICY;
	}

	constructor(private readonly deps: ManagerControllerDeps) {
		this.forwards = new ForwardBursts(deps.forwards ?? DEFAULT_FORWARD_POLICY);
		this.scheduler = new ChatScheduler({
			continueWindowMs: deps.continueWindowMs,
			clock: deps.clock,
		});
		this.gate = new ReplyGate({
			ownerReplyWindowMs: deps.ownerReplyWindowMs,
			clock: deps.clock,
		});
	}

	/** The per-turn decision sink the manager tools write into. */
	decisionSink(): DecisionState {
		return this.decision;
	}

	/**
	 * What the memory tools need to run: which contact's database is open, who it is
	 * about, and where to record what they did.
	 *
	 * Resolving the database HERE, from the active chat, is the isolation guarantee.
	 * The tools have no database argument, so there is no path by which a model
	 * answering one person can touch another's memory — not a rule it is asked to
	 * follow, an address it is never given.
	 */
	memoryToolContext(): MemoryToolContext {
		return {
			active: () => this.activeMemory(),
			contactName: () => {
				const chatId =
					this.consolidating?.chatId ?? this.scheduler.activeChat();
				return (chatId && this.chats.get(chatId)?.contactName) || "the contact";
			},
			ledger: () => this.consolidating?.ledger ?? this.scratchLedger,
			now: () => this.deps.clock.now(),
			// The same zone the `[Now: …]` line uses, so a date read there and a date
			// asked about are the same day.
			timezone: this.deps.timezone,
		};
	}

	/** Whether the active memory pass has exhausted its inspection-only allowance. */
	isConsolidationRecallBlocked(): boolean {
		return this.consolidating?.ledger.recallBlocked() ?? false;
	}

	/**
	 * The memory of whoever this turn is about, or null when there is nobody to
	 * remember — an unidentified chat, or the owner talking to their own bot.
	 *
	 * The owner check is by USER ID, in code, before the model is involved: a
	 * namesake cannot be mistaken for the owner, and the owner's own details can
	 * never be filed under a contact.
	 */
	private async activeMemory(): Promise<ContactMemory | null> {
		const chatId = this.consolidating?.chatId ?? this.scheduler.activeChat();
		if (chatId === null) return null;
		const userId = this.chats.get(chatId)?.userId;
		if (!userId) return null;
		if (await this.isOwnerUserId(userId)) return null;
		try {
			return await this.deps.memory.for(userId);
		} catch (error) {
			this.reportMemoryError(error);
			return null;
		}
	}

	/**
	 * Say once, to the owner, that the memory is not working — and carry on.
	 *
	 * Once, because the cause is a file or a setting: it will fail identically on every
	 * turn until somebody changes something, and a warning repeated every minute is how
	 * people learn to scroll past warnings.
	 */
	private reportMemoryError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (this.memoryErrorsSeen.has(message)) return;
		this.memoryErrorsSeen.add(message);
		this.deps.onMemoryError?.(message);
	}

	/** The per-turn sink the resolve-draft tool writes into (revise turns). */
	resolveSink(): DraftResolutionState {
		return this.resolve;
	}

	/**
	 * Whether the active chat is on a REVISE turn: a reply is held (either drafted
	 * last turn and held because new interlocutor messages landed, or recovered from a
	 * plain-text turn) and the model must now resolve it (send/refine/drop). Public so
	 * the tool matcher can reveal telegram_manager_resolve_draft only on these turns (and hide it
	 * everywhere else).
	 */
	isReviseTurn(): boolean {
		const active = this.scheduler.activeChat();
		return (
			active !== null && this.pendingReply.has(active) && !this.consolidating
		);
	}

	/**
	 * Whether the model has made this turn's terminal decision, so the agent loop
	 * can stop re-sampling instead of spinning on identical context. Terminality is
	 * turn-type specific: a normal turn ends on reply/silent; a memory pass ends
	 * only when the model says it is finished.
	 */
	turnDecided(): boolean {
		if (this.consolidating) {
			// A pass spans a whole agent run, however many tool calls it takes. Only
			// telegram_manager_done ends it — see `consolidation.ts` for what stops a pass that
			// will not say so itself.
			return this.consolidating.ledger.isFinished();
		}
		// Revise turn: the gate ends the turn ONLY when the model resolved the held
		// draft — a plain telegram_manager_reply/telegram_manager_silent must not complete it, so a
		// ready answer can never be dropped by calling silent on trailing chatter.
		if (this.isReviseTurn()) {
			return this.resolve.current().action !== "none";
		}
		return this.decision.current().kind !== "none";
	}

	/** Whether an idle memory-consolidation pass is currently running. */
	isConsolidating(): boolean {
		return this.consolidating !== null;
	}

	/**
	 * Whether the running memory pass is over and only waiting for the run to end.
	 * Public so the tool gate can take the memory tools away: a model that has just
	 * said it is finished, and can still see the tools it finished with, calls one of
	 * them again — it did, every pass, until the runtime aborted the run.
	 */
	isConsolidationDone(): boolean {
		return this.consolidating?.ledger.isFinished() === true;
	}

	/**
	 * Settle one sample of a memory pass at `turn_end`, and say whether the run stops.
	 *
	 * This is the second queue in action. Every other turn in this project is settled by
	 * asking what reached Telegram; a memory pass sends nothing to anybody, so that
	 * question has no answer here and this reads the ledger instead — what the model
	 * called, whether it called anything at all, and how much of the pass's budget is
	 * left. The rules live in `consolidation.ts`; this adds the one piece of state that
	 * module cannot see.
	 *
	 * That piece is live work. A person waiting for a reply outranks a background pass
	 * unconditionally, so the moment anything is unserved the run yields — `onAgentEnd`
	 * then parks the pass with its ledger intact and serves the chat.
	 *
	 * Nothing is lost by stopping at any point: every memory tool writes on the spot
	 * (see `memory-tools.ts`), so a pass cut off mid-thought has already saved what it
	 * decided before the cut.
	 */
	async stepConsolidation(): Promise<"continue" | "abort"> {
		const current = this.consolidating;
		if (!current) return "continue";
		const verdict = consolidationVerdict(
			current.ledger,
			this.deps.consolidationLimits,
		);
		// Read the ledger's per-turn flag BEFORE clearing it for the next sample, and clear
		// it whatever the verdict: a paused pass resumes into a fresh turn too.
		current.ledger.startTurn();
		if (verdict === "abort") return "abort";
		// A reply is now waiting: yield so a live answer is never delayed by a memory pass.
		if (this.unserved.size > 0) return "abort";
		return "continue";
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
		// Who the owner is decides EVERYTHING about a message: their own messages are
		// context, an interlocutor's are the job. The
		// stored connection is the authority — but it can be missing (Telegram only
		// sends `business_connection` on change, so a bot connected before its first
		// run has none until traffic teaches us), and without a fallback every owner
		// message, including the bot's own echo, was classified as an interlocutor's.
		// `ownerUserId` is the configured account owner, which is exactly who the
		// business account belongs to.
		const ownerId = connection?.userId ?? this.deps.ownerUserId;
		const fromOwnerSide =
			ownerId !== undefined && String(input.fromId) === ownerId;

		// A batch of forwards is content pasted in from elsewhere, not a message
		// written here: it gets its own budget (chars per forward, forwards per
		// batch). Past the batch limit the body is not read at all — one note says so
		// and the rest of the burst is dropped, before any media is even downloaded.
		const forward = this.forwards.track(
			chatId,
			input.message.forward_origin !== undefined,
			now,
			input.message.media_group_id,
		);
		const forwardDropped = forward?.overLimit === true;
		const forwardBody = (body: string): string =>
			forward?.overLimit
				? forwardLimitNote(this.forwardPolicy.maxMessages)
				: forward
					? limitForwardText(body, this.forwardPolicy.maxChars)
					: body;

		if (fromOwnerSide) {
			// The owner's side: either the bot's own echo (ignore) or a manual message,
			// which stands the bot down for this batch.
			const bot = await isBotMessage(
				{ chatId, messageId, text },
				this.deps.sentRegistry,
			);
			if (bot) return;
			// When the owner is putting something to the bot — a wake-word now, or a
			// follow-up to a summons still open — a photo they attach or REPLY to must
			// reach vision, exactly like an interlocutor's. Otherwise "look at this,
			// what do you see?" arrives as the bare `<photo>` reply-label and the model
			// hallucinates a picture. Ordinary owner chatter ingests nothing: no turn
			// will run for it, so downloading its media would be pure waste.
			const summons =
				now - messageTime <= this.deps.liveFreshnessMs &&
				matchesMention(text, this.deps.mentionWords);
			const media =
				(summons || this.ownerSummoned.has(chatId)) && !forwardDropped
					? await this.ingestMedia(chatId, input.message)
					: {
							note: "",
							kind: undefined as string | undefined,
							imageRefs: [],
						};
			const ownerBody = forwardBody(stripBotMarker(text));
			const ownerText = media.note
				? ownerBody
					? `${media.note} ${ownerBody}`
					: media.note
				: ownerBody;
			// A dropped forward still counts as the owner speaking (the gate below), it
			// simply leaves no body in the transcript.
			if (!forwardDropped || forward?.justHitLimit) {
				await this.deps.chatStore.append(chatId, {
					author: "owner",
					text: ownerText,
					context: messageContext(input.message),
					forwarded: input.message.forward_origin !== undefined,
					timestamp: messageTime,
					senderId: ownerId,
					messageId,
					kind: media.kind,
					imageRefs: media.imageRefs.length ? media.imageRefs : undefined,
				});
				// The owner's own line in this chat is part of what happened in it, so it
				// belongs in the memory of the person they were talking to — that is the
				// conversation it is about. Their words, not a fact about them.
				await this.recordEpisode(
					chatId,
					ownerText,
					["owner"],
					messageTime,
					messageId === undefined
						? undefined
						: { messageId: String(messageId) },
				);
			}
			await this.touchConsolidation(chatId, messageTime);
			// An explicit wake-word from the owner summons the bot, even though it never
			// acts on owner messages otherwise. This is the ONE way an owner message
			// opens a turn — and the only way the model may answer the owner at all.
			// A stale/backlog message never wakes.
			if (summons) {
				const existing = this.chats.get(chatId);
				this.chats.set(chatId, {
					connectionId: input.connectionId,
					contactName: existing?.contactName ?? chatId,
					userId: existing?.userId,
				});
				this.ownerSummoned.add(chatId);
				this.unserved.add(chatId);
				this.scheduler.onMessage(chatId);
				return;
			}
			// The owner called the bot moments ago and is still assembling the request —
			// a screenshot, the forwards they were asking about, a second sentence. Those
			// follow-ups must NOT cancel the summons: the question was put to the BOT, so
			// the chat stays unserved until the turn actually runs (the tick that starts
			// it can be seconds away). Without this, every message the owner added to
			// their own question erased it.
			if (this.ownerSummoned.has(chatId)) {
				if (this.scheduler.activeChat() === chatId && !this.deps.isIdle()) {
					this.dirtyDuringTurn.add(chatId);
				}
				return;
			}
			// The owner wrote while the model was still generating a reply for this very
			// chat. The draft is now stale — the owner may have answered the question
			// themselves — so it must NOT be sent blind: flag the turn dirty and leave
			// the chat unserved, which is what makes turn end HOLD the draft and give the
			// model a revise turn (`telegram_manager_resolve_draft`: send / refine / drop). Note
			// the chat deliberately stays unserved: `triggerTurn` needs it to run that
			// revise turn, and clearing it here would strand the draft forever.
			if (this.scheduler.activeChat() === chatId && !this.deps.isIdle()) {
				this.dirtyDuringTurn.add(chatId);
				return;
			}
			// The owner answered inside the window: this batch is theirs, the bot stays
			// out of it. Only this batch — the chat is not switched off, and the
			// interlocutor's next message arms a fresh window (no freeze).
			this.gate.onOwnerMessage(chatId);
			// The owner is present, so the fast lane closes too: the bot's continuation
			// window must not let the interlocutor's next message skip the owner's turn
			// to answer.
			this.scheduler.dropContinuation(chatId);
			this.unserved.delete(chatId);
			this.latestImages.delete(chatId);
			return;
		}

		// The interlocutor.
		// Past the forward limit their batch stops here: not stored, no media fetched,
		// no reply cycle opened. The one message that crossed the limit carries the
		// note (below) so the model can see that something was withheld.
		if (forwardDropped && !forward?.justHitLimit) return;
		const from = input.message.from;
		const contactName = from
			? extractProfileFromUser(from).displayName
			: chatId;
		this.chats.set(chatId, {
			connectionId: input.connectionId,
			contactName,
			userId: from ? String(from.id) : undefined,
			lastMessageId: input.message.message_id,
		});
		if (from) {
			await this.deps.contactStore.upsertProfile(
				extractProfileFromUser(from),
				now,
			);
		}
		const media = forwardDropped
			? { note: "", kind: undefined, imageRefs: [] }
			: await this.ingestMedia(chatId, input.message);
		const baseText = forwardBody(text);
		const storedText = media.note
			? baseText
				? `${media.note} ${baseText}`
				: media.note
			: baseText;
		await this.deps.chatStore.append(chatId, {
			author: "interlocutor",
			text: storedText,
			context: messageContext(input.message),
			forwarded: input.message.forward_origin !== undefined,
			timestamp: messageTime,
			senderId: from ? String(from.id) : undefined,
			senderName: contactName,
			messageId,
			kind: media.kind,
			imageRefs: media.imageRefs.length ? media.imageRefs : undefined,
		});
		// Every inbound message goes into the memory, whether or not it ever produces a
		// turn: what a person said is worth keeping even when the owner answered it
		// themselves, and the transcript it is stored beside will be pruned long before
		// anybody asks about it. `ownWords` rather than the stored text, so a reply's
		// quoted paragraphs are not filed as something THEY said.
		await this.recordEpisode(
			chatId,
			ownWords({
				author: "interlocutor",
				text: storedText,
				context: messageContext(input.message),
				forwarded: input.message.forward_origin !== undefined,
				timestamp: messageTime,
			}),
			["message"],
			messageTime,
			messageId === undefined ? undefined : { messageId: String(messageId) },
		);
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
	): Promise<{ note: string; kind?: string; imageRefs: StoredImageRef[] }> {
		const refs = describeAttachments(message, this.deps.maxBytes);
		// A reply may carry no attachment of its own yet still POINT at a photo — so the
		// replied-to picture is checked before the early return, or a "look at this"
		// text reply would drop it.
		const repliedTo = message.reply_to_message;
		const repliedImageRefs =
			this.deps.media.images && repliedTo
				? describeAttachments(repliedTo as Message, this.deps.maxBytes).filter(
						isImage,
					)
				: [];
		if (refs.length === 0 && repliedImageRefs.length === 0)
			return { note: "", imageRefs: [] };
		const images = refs.filter(isImage);
		const imageRefs = this.deps.media.images
			? dedupeImageRefs(
					[...images, ...repliedImageRefs].map((ref) => ({
						fileId: ref.fileId,
						fileSize: ref.fileSize,
						mimeType: ref.mimeType,
					})),
				)
			: [];
		const documents = refs.filter((ref) => !isImage(ref));
		const parts: string[] = [];
		if (images.length > 0) {
			if (this.deps.media.images) {
				parts.push("[image]");
				this.stashImages(
					chatId,
					(await this.deps.loadImages?.(message)) ?? [],
					message.message_id,
				);
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
		// A reply to a photo points at it — load the replied-to picture too (mode-2
		// vision), so the model sees what the interlocutor is answering rather than only
		// its own note. Documents in a reply stay refused (repliedImageRefs is images
		// only); only pictures are ever pulled in.
		if (repliedImageRefs.length > 0 && repliedTo) {
			parts.push("[replied image]");
			this.stashImages(
				chatId,
				(await this.deps.loadImages?.(repliedTo as Message)) ?? [],
				message.message_id,
			);
		}
		return { note: parts.join(" "), kind: refs[0]?.kind, imageRefs };
	}

	/** Merge freshly-loaded images into the freshest turn and historical cache. */
	private stashImages(
		chatId: string,
		loaded: IsolatedImage[],
		messageId?: number,
	): void {
		if (loaded.length === 0) return;
		const pending = this.latestImages.get(chatId) ?? [];
		const merged = [...pending, ...loaded];
		const cap = this.deps.maxImages;
		const capped = cap && merged.length > cap ? merged.slice(-cap) : merged;
		this.latestImages.set(chatId, capped);
		if (messageId !== undefined) {
			const historical = this.historicalImages.get(chatId) ?? new Map();
			const previous = historical.get(messageId) ?? [];
			historical.set(messageId, [...previous, ...loaded]);
			this.historicalImages.set(chatId, historical);
		}
	}

	private async loadHistoricalImages(
		chatId: string,
		records: readonly ChatMessageRecord[],
	): Promise<ReadonlyMap<number, IsolatedImage[]>> {
		const cached = this.historicalImages.get(chatId) ?? new Map();
		if (!this.deps.loadImageRefs) return cached;
		for (const record of records) {
			if (
				record.messageId === undefined ||
				!record.imageRefs?.length ||
				cached.has(record.messageId)
			)
				continue;
			cached.set(
				record.messageId,
				(await this.deps.loadImageRefs(record.imageRefs)) ?? [],
			);
		}
		this.historicalImages.set(chatId, cached);
		return cached;
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
	 * Put a chat that already has a transcript back in line for memory consolidation.
	 *
	 * The queue is fed by live traffic alone, and the in-memory chat map starts empty:
	 * a chat whose last message arrived before this process did was therefore never a
	 * candidate, and its facts were never consolidated — for a bot that is restarted
	 * often, that is every chat. So on activation the transcripts on disk are queued,
	 * stamped with their real last-activity time, and an idle manager works through
	 * them. A chat already queued keeps its stamp (upsert is by chat id), and one that
	 * has since been consolidated is simply reconsolidated — facts are deduplicated
	 * where they are stored.
	 */
	async seedConsolidation(
		chatId: string,
		meta: ChatMeta,
		activityAt: number,
	): Promise<void> {
		if (!this.chats.has(chatId)) this.chats.set(chatId, meta);
		await this.touchConsolidation(chatId, activityAt);
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
		// agent_end is not terminal: Pi may retry, compact, or continue the same run
		// after this event. Keep the memory pass and its tool gate alive until
		// onAgentSettled, otherwise the continuation would see telegram_manager_reply/silent and
		// mistake a background pass for a conversation turn.
		if (this.consolidating) {
			return null;
		}
		const active = this.scheduler.activeChat();
		if (active === null) return null;
		let text: string | null;
		let requestedReplyTo: number | undefined;
		let decisionKind: "reply" | "silent" | "none";
		let category: MessageCategory | undefined;
		let silentReason: string | undefined;
		let needsReply: boolean | undefined;
		// A REVISE turn: a held draft is pending, so the resolve-draft tool — not
		// telegram_manager_reply/telegram_manager_silent — carries the outcome (the gate guaranteed it
		// was called, or an unresolved run falls back to sending the draft as-is).
		const pending = this.pendingReply.get(active);
		if (pending) {
			const resolution = this.resolve.current();
			this.resolve.reset();
			this.decision.reset();
			if (resolution.action === "drop") {
				text = null;
				decisionKind = "silent";
				needsReply = false;
				silentReason = resolution.reason ?? "dropped the held draft";
			} else {
				// send | refine | none (gate fallback): never lose a ready answer. A
				// resolved draft is an explicit, considered reply, so it reads as a
				// direct question and bypasses the chatter guard below. On an unresolved
				// prose-recovery turn the model may have re-written its answer as plain
				// text again — prefer that fresh prose over the held draft.
				const freshProse = finalText?.trim();
				text =
					resolution.action === "refine" && resolution.text
						? resolution.text
						: resolution.action === "none" && pending.fromProse && freshProse
							? freshProse
							: pending.text;
				requestedReplyTo = pending.replyTo;
				decisionKind = "reply";
				category = "question";
				needsReply = true;
			}
		} else {
			const decision = this.decision.current();
			text = resolveDecision(decision);
			requestedReplyTo =
				decision.kind === "reply" ? decision.replyTo : undefined;
			// Capture the decision's descriptive fields before the reset clears them.
			decisionKind = decision.kind;
			category =
				decision.kind === "reply" || decision.kind === "silent"
					? decision.category
					: undefined;
			silentReason = decision.kind === "silent" ? decision.reason : undefined;
			needsReply =
				decision.kind === "reply" || decision.kind === "silent"
					? decision.needsReply
					: undefined;
			this.decision.reset();
		}
		const meta = this.chats.get(active);
		const contactName = meta?.contactName ?? active;
		// The interlocutor's identity fields for the debug-feed card (username/phone
		// come from the stored profile; phone only exists if they shared a contact).
		const profile = meta?.userId
			? (await this.deps.contactStore.get(meta.userId))?.profile
			: undefined;
		const contact = {
			chatId: active,
			contactName,
			username: profile?.username,
			phone: profile?.phoneNumber,
			userId: meta?.userId,
			languageCode: profile?.languageCode,
			isPremium: profile?.isPremium,
			isBot: profile?.isBot,
			lastMessageId: meta?.lastMessageId,
		};
		this.gate.clearServed(active);
		// The model ended in plain text without calling a tool. Plain text is never
		// delivered, so the reply was lost. Instead of re-deciding from scratch (a weak
		// model may relabel a real question as chatter, and the guard then drops the
		// answer), hold the prose as a draft and route it through the resolve-draft gate:
		// the model must explicitly send/refine/drop it, and an unresolved run sends it —
		// so a composed answer is never silently lost. A sent draft reads as a considered
		// reply (category question) and bypasses the chatter guard below.
		const prose = finalText?.trim();
		// New message(s) arrived while this turn was generating: a draft must be
		// reconsidered against them, not sent blind.
		const arrivedMidTurn = this.dirtyDuringTurn.delete(active);
		// Which side pulled the bot into this turn — read before the cleanup below clears
		// `ownerSummoned`. It scopes the over-reply guard and the reply's thread target,
		// and it gates the prose fast-path just below.
		const triggerSide: TriggerSide = this.ownerSummoned.has(active)
			? "owner"
			: "interlocutor";
		// The model ended in plain text without a tool call — plain text is never
		// delivered to Telegram, so the composed answer would be lost.
		//
		// When the OWNER summoned this turn, a reply is already expected — they asked
		// outright — so a prose answer with nothing new since IS that reply: send it
		// directly, no resolve-draft hop and no confused spiral over who it is for. This
		// is deliberately owner-only: it must never nudge a reply where the silence
		// hierarchy did not already call for one. For every other prose the behaviour is
		// unchanged — it is held and routed through the resolve gate, where the model can
		// still drop it (it may have been only its own reasoning, or a message it meant
		// to let pass in silence).
		if (decisionKind === "none" && prose && !this.pendingReply.has(active)) {
			if (triggerSide === "owner" && !arrivedMidTurn) {
				text = prose;
				decisionKind = "reply";
				category = "question";
				needsReply = true;
			} else {
				this.pendingReply.set(active, { text: prose, fromProse: true });
				await this.triggerTurn();
				return { ...contact, outcome: "corrected", text: prose };
			}
		}
		// A tool-call reply held because newer messages arrived: don't send the now-
		// stale draft blind. Hold it, keep the chat unserved, and let the model
		// reconsider next turn (revise or resend) — but only up to reviseThreshold
		// times, so a rapid sender cannot defer the reply forever; past the cap it is
		// sent as-is.
		if (text && arrivedMidTurn) {
			const cycles = this.reviseCount.get(active) ?? 0;
			if (cycles < this.deps.reviseThreshold) {
				this.reviseCount.set(active, cycles + 1);
				this.pendingReply.set(active, { text, replyTo: requestedReplyTo });
				await this.triggerTurn();
				return { ...contact, outcome: "held", text, category };
			}
		}
		// The turn settled — this chat is served, whatever the model decided.
		this.unserved.delete(active);
		this.ownerSummoned.delete(active);
		this.latestImages.delete(active);
		this.pendingReply.delete(active);
		this.reviseCount.delete(active);
		// And say so on disk. `unserved` is the truth about what has been dealt with, and
		// it dies with the process: a turn that ended in silence — banter, a sticker, a
		// laugh — writes nothing to the transcript, so on the next launch the chat still
		// looked like someone waiting for an answer, and the bot went and answered it. A
		// day-old joke, replied to, every restart. The cursor is that silence, written
		// down.
		await this.markHandled(active);
		let deliveredReplyTo: number | undefined;
		let guardReason: string | undefined;
		if (text) {
			const records = meta
				? await this.deps.chatStore.getRecent(
						active,
						this.deps.rememberMessages,
					)
				: [];
			// Strict guard against a weak model over-replying to banter: unless the bot
			// was addressed directly — by category, an owner summons, or a wake-word on
			// the trigger's own message — drop a reply the model itself tagged as
			// chatter/acknowledgement or as not needing an answer.
			if (this.deps.strictReplyGuard && decisionKind === "reply") {
				const trigger = triggerMessage(records, triggerSide);
				const addressed =
					category === "addressed_to_bot" ||
					triggerSide === "owner" ||
					(trigger !== undefined &&
						matchesMention(trigger.text, this.deps.mentionWords));
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
				deliveredReplyTo = resolveReplyTarget(
					records,
					requestedReplyTo,
					triggerSide,
				);
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
		// What the bot did about this batch, and why — the half of the record that the
		// transcript cannot hold. A delivered reply is already in the transcript; a
		// SILENCE is not, and "I decided not to answer that, because it was banter" is
		// exactly the kind of thing the owner (and the next pass) needs to be able to
		// find. Stored as the model's own account of its turn.
		await this.recordEpisode(
			active,
			text
				? `Replied to ${contactName}: ${text}`
				: `Stayed silent with ${contactName}${
						(silentReason ?? guardReason)
							? `: ${silentReason ?? guardReason}`
							: ""
					}`,
			["turn", text ? "reply" : "silent"],
			this.deps.clock.now(),
			category ? { category } : undefined,
		);
		if (text) {
			// Replied: keep the chat active and arm the 2:00 continuation window.
			this.scheduler.onReplied();
		} else {
			// Silent (or guard-dropped): release the chat and promote the next.
			this.scheduler.next();
		}
		await this.triggerTurn();
		return text
			? {
					...contact,
					outcome: "reply",
					text,
					category,
					replyToMessageId: deliveredReplyTo,
				}
			: {
					...contact,
					outcome: "silent",
					text: silentReason ?? guardReason,
					category,
				};
	}

	/**
	 * Finish a background memory pass only after Pi confirms that no retry, compaction,
	 * or queued continuation remains. Until this point the pass owns the tool list.
	 */
	async onAgentSettled(): Promise<void> {
		if (!this.consolidating) return;
		await this.finishConsolidationRun();
	}

	/**
	 * Advance time: chats whose owner-reply window expired in silence become ready
	 * (first engagement), and the active chat is released when its continuation
	 * window lapses; then start a turn if the agent is idle.
	 */
	async onTick(): Promise<void> {
		for (const chatId of this.gate.onTick()) {
			// A chat released by the window has an unanswered message by definition —
			// the gate only returns chats with a pending batch.
			this.unserved.add(chatId);
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
		// The whole transcript, because the window that is cut from it is ANCHORED to the
		// conversation's length — a window measured from the end alone slides by one line
		// per line, and a transcript whose first line moves is a transcript the model must
		// read again from the top. (`getRecent` reads the same file to serve its slice, so
		// this costs no more I/O.)
		const raw = await this.deps.chatStore.all(active);
		// Rehydrate the contact's userId from the transcript if the in-memory meta
		// lacks it (e.g. after a restart, before a fresh live message repopulates it),
		// so known facts are shown and new facts are stored by the right contact.
		this.rememberUserId(active, raw);
		const records = windowRecords(raw, {
			maxMessages: this.deps.rememberMessages,
			maxCharsPerMessage: this.deps.maxCharsPerMessage,
			maxContextChars: this.deps.maxContextChars,
		});
		const historicalImages = await this.loadHistoricalImages(active, records);
		const meta = this.chats.get(active);
		const isolated = buildIsolatedMessages({
			records,
			boundary: boundaryDirective(meta?.contactName ?? active),
			latestImages: this.latestImages.get(active),
			imagesByMessageId: historicalImages,
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
		const memory = await this.activeMemory();
		const known = await this.recallBlock(
			active,
			records,
			meta?.contactName,
			memory,
		);
		// The head message is the same bytes for every chat and every turn of the session.
		//
		// That is not a stylistic preference, it is the whole cost model. Every backend
		// re-reads a prompt from the first byte that differs from the last one it saw, so
		// anything written ABOVE the transcript is charged the entire transcript whenever
		// it changes. The opener and the known facts used to live up here, and the bench
		// (tests/modes/manager/prefix-reuse.test.ts) priced them: in a chat of ordinary
		// pasted-length messages, ONE learned fact cost 19,397 characters of re-reading —
		// the whole conversation, re-read to say one new line about the person.
		//
		// The recall block makes that rule load-bearing rather than merely wise: it is
		// fetched fresh for every batch, so it is the single most volatile thing in the
		// prompt. Above the transcript it would re-read the conversation every time
		// anybody said anything.
		//
		// So the rule is: above the transcript goes only what never changes; everything
		// that varies — the clock, the opener, the memory, the state, the directive —
		// travels in the trailing message, where it is charged for itself alone.
		const system = `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${this.deps.instructions.base}${this.ownerLine()}`;
		const pending = this.pendingReply.get(active);
		const directive = this.turnDecided()
			? MANAGER_TURN_DONE
			: pending
				? pending.fromProse
					? proseResolveDirective(pending.text)
					: reviseDirective(pending.text)
				: MANAGER_ACTION_TRIGGER;
		// Name who pulled the bot into this turn — the owner (a summons) or the
		// interlocutor (a waiting message) — and which message to thread a reply to,
		// so the answer attaches to the right party, not a bystander's trailing line.
		// Only on an action turn (not a done/revise directive) and only when there is
		// actually something owed: a summons open, or the interlocutor left waiting.
		const triggerSide: TriggerSide = this.ownerSummoned.has(active)
			? "owner"
			: "interlocutor";
		const owed = this.ownerSummoned.has(active) || state.interlocutorWaiting;
		const trigger = owed ? triggerMessage(records, triggerSide) : undefined;
		const directAddressed =
			this.ownerSummoned.has(active) ||
			(trigger !== undefined &&
				matchesMention(trigger.text, this.deps.mentionWords));
		const hint =
			directive === MANAGER_ACTION_TRIGGER && owed
				? triggerHint(records, triggerSide, this.deps.mentionWords)
				: "";
		const stateCard =
			directive === MANAGER_ACTION_TRIGGER
				? conversationStateCard(records, { directAddressed })
				: "";
		return [
			{ role: "user", content: system },
			...isolated,
			{
				role: "user",
				content: [
					this.nowLine(),
					opener,
					known,
					`${stateCard}${hint ? `\n\n${hint}` : ""}`,
					directive,
				]
					.filter((part) => part.trim())
					.join("\n\n"),
			},
		];
	}

	/** Who the model is answering for. Constant for the session, so it rides in the head. */
	private ownerLine(): string {
		const ownerName = this.deps.ownerName?.trim();
		return ownerName
			? `\n\nThe account Owner's name is ${ownerName}. When you introduce ` +
					`yourself, say you are ${ownerName}'s assistant.`
			: "";
	}

	/**
	 * Build the context for a memory pass: the consolidation system block, the
	 * isolated transcript, then the pass's current memory and its directive.
	 *
	 * The memory shown here is the WHOLE of what is held about this person, not a
	 * relevance-ranked slice — a pass exists to decide what should still be there, and
	 * it cannot decide that about facts it was not shown. The reply turn's block is
	 * the opposite (see {@link recallBlock}) because a reply needs what bears on the
	 * question, not an inventory.
	 */
	private async buildConsolidationContext(): Promise<IsolatedMessage[]> {
		const current = this.consolidating as ConsolidationPass;
		const raw = await this.deps.chatStore.all(current.chatId);
		this.rememberUserId(current.chatId, raw);
		const records = windowRecords(raw, {
			maxMessages: this.deps.rememberMessages,
			maxCharsPerMessage: this.deps.maxCharsPerMessage,
			maxContextChars: this.deps.maxContextChars,
		});
		const meta = this.chats.get(current.chatId);
		const isolated = buildIsolatedMessages({
			records,
			boundary: boundaryDirective(meta?.contactName ?? current.chatId),
		});
		const memory = await this.activeMemory();
		const held = memory
			? await memory.recall({
					entities: [meta?.contactName ?? current.chatId],
					tags: ["fact"],
					tokenBudget: this.deps.recallTokenBudget,
				})
			: null;
		// Constant above the transcript, everything that varies below it — the same rule as
		// `buildContextForActive`, and for the same measured reason. The memory block is the
		// most volatile thing in a pass (it is what the pass EXISTS to change), so it is the
		// last thing that may sit on top of the conversation.
		const system = `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${CONSOLIDATION_INSTRUCTIONS}`;
		return [
			{ role: "user", content: system },
			...isolated,
			{
				role: "user",
				content: [
					this.nowLine(),
					consolidationMemoryBlock(held?.rendered ?? ""),
					current.ledger.contextDraft(),
					consolidationDirective(current.ledger, this.deps.consolidationLimits),
				]
					.filter((part) => part.trim())
					.join("\n\n"),
			},
		];
	}

	/** Status for the banner/footer. */
	status(): {
		activeChat?: string;
		queued: number;
		holding: number;
	} {
		const active = this.scheduler.activeChat();
		return {
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
	 *
	 * `isIdle()` is a real answer, not a formality, and it is false on every path that
	 * reaches here from {@link onAgentSettled} — a run cannot take a prompt while it is
	 * still ending. Declining costs nothing: the chat stays unserved, the draft stays
	 * held, and the host asks again the moment the session settles.
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
		if (!(await this.hasSomethingToAnswer(active))) return false;
		this.decision.reset();
		this.resolve.reset();
		// A new batch deserves a fresh look at the memory; the cache exists to hold one
		// turn's block still, not to carry it into the next turn.
		this.recallCache = null;
		// Fresh turn: only messages that arrive AFTER this point count as mid-turn
		// arrivals that should trigger a reconsider.
		this.dirtyDuringTurn.delete(active);
		const meta = this.chats.get(active);
		if (meta) {
			await this.deps
				.typing({ connectionId: meta.connectionId, chatId: active })
				.catch(() => {});
		}
		// A revise turn names the only tool that can end it: reply/silent are hidden
		// and blocked while a draft is held, so prompting for them wastes the turn.
		await this.deps.triggerAgent(
			this.pendingReply.has(active)
				? "A drafted reply is held for review in the active Telegram chat. Resolve it by calling telegram_manager_resolve_draft."
				: "Respond to the latest messages in the active Telegram chat by calling telegram_manager_reply or telegram_manager_silent.",
		);
		return true;
	}

	/**
	 * The invariant that keeps the bot out of the owner's mouth: a turn may start
	 * ONLY for something that is actually waiting on us.
	 *
	 * Three cases qualify, and nothing else:
	 *  - an interlocutor message nobody has answered (`analyzeChat`);
	 *  - a chat the owner summoned with a wake-word — the one case where the model
	 *    may answer the owner at all;
	 *  - a held draft awaiting `telegram_manager_resolve_draft`.
	 *
	 * `unserved` already implies this, but only by construction: every path that
	 * sets it would have to stay correct forever. Checking the transcript makes it
	 * structural. Concretely it is what stops the case the owner hit live — writing
	 * "did you buy bread?" to the interlocutor and having the BOT answer "yes":
	 * after an owner message nothing is unanswered, so there is no turn to run.
	 */
	private async hasSomethingToAnswer(chatId: string): Promise<boolean> {
		if (this.ownerSummoned.has(chatId) || this.pendingReply.has(chatId)) {
			return true;
		}
		const records = await this.deps.chatStore.getRecent(
			chatId,
			this.deps.rememberMessages,
		);
		// Who spoke LAST, by transcript order — not by timestamp: Telegram dates are
		// whole seconds, so an owner message and an interlocutor's in the same second
		// compare as equal, and a timestamp test would call the chat answered while the
		// interlocutor is in fact still waiting.
		const state = analyzeChat(records);
		if (!state.interlocutorWaiting || state.lastInterlocutorAt === null)
			return false;
		// A deliberate silent turn has no bot line to put after the interlocutor's
		// message. The durable handled cursor is therefore part of the answer check;
		// without it, every old silent chat would be promoted ahead of consolidation
		// forever.
		const cursor = await this.deps.chatCursors.get(chatId);
		return (
			cursor?.handledThrough === undefined ||
			state.lastInterlocutorAt > cursor.handledThrough
		);
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
	 * What the memory holds that bears on the messages being answered — the block that
	 * replaced "Known facts about X".
	 *
	 * Two differences from the list it replaced, and both are the point. It is RANKED
	 * against the unanswered batch rather than being the whole store, so a memory of a
	 * thousand facts costs the same in the prompt as a memory of ten and spends that
	 * budget on the ones that matter to what was just said. And it is bounded in
	 * TOKENS rather than in facts, so the cap means what it is for: how much of the
	 * turn the memory may occupy.
	 *
	 * Cached for the turn, because `pi.on("context")` runs before every sample and a
	 * block that came back in a different order on the second call would make the
	 * backend re-read the trailing message for nothing.
	 *
	 * Returns "" when there is nothing to say — no memory, no batch, or no hits.
	 */
	private async recallBlock(
		chatId: string,
		records: readonly ChatMessageRecord[],
		contactName: string | undefined,
		memory: ContactMemory | null,
	): Promise<string> {
		// A normal turn recalls the unanswered interlocutor batch. When the Owner
		// summons the bot inside a contact chat, use the current contact's memory
		// without a text query: the Owner may be asking for an inventory such as
		// "what do you remember about them?", which has no lexical overlap with
		// the stored facts. This is deliberately not a name-to-database lookup:
		// activeMemory() already selected the database from the current chat's
		// Telegram userId.
		const ownerSummoned = this.ownerSummoned.has(chatId);
		const query = ownerSummoned ? "" : recallQuery(records);
		// Nothing outstanding means nothing to look up, except for an Owner summon:
		// the explicit summon is the request to inspect this current contact's memory.
		if (!query && !ownerSummoned) return "";
		const cached = this.recallCache;
		if (cached && cached.chatId === chatId && cached.query === query) {
			return cached.block;
		}
		if (!memory) return "";
		const name = contactName ?? chatId;
		const result = await memory.recall({
			query: query || undefined,
			entities: [name],
			k: this.deps.recallK,
			tokenBudget: this.deps.recallTokenBudget,
		});
		// Anything the transcript above still shows is the transcript's job — see
		// `dropVisible`. Without it the block opens by quoting back the message sitting
		// three lines above it, because that message is an episode too.
		const block = memoryBlock(dropVisible(result.rendered, records), name);
		this.recallCache = { chatId, query, block };
		return block;
	}

	/**
	 * Record something that happened, as an episode in the contact's memory.
	 *
	 * Episodes are why the memory outlives the transcript. The JSONL log is compacted
	 * to twice the reading window, so a conversation from last month is simply not on
	 * disk any more — while the questions people actually ask ("what did we agree?",
	 * "did I ever tell them?") are about exactly that. A message costs microseconds to
	 * store and nothing at all in the prompt until a recall ranks it highly enough to
	 * be worth saying.
	 *
	 * Best-effort by design: an episode is a nicety, and a memory that will not write
	 * must not stop a reply from going out. The failure surfaces on the next tool call
	 * the model makes, which is where it can actually be acted on.
	 *
	 * The subject is {@link MEMORY_EPISODE_ENTITY} and never the contact — see there
	 * for what filing a conversation under the person breaks. The edge that keeps the
	 * two joined is written once per contact per run rather than per message: it is a
	 * journal append like any other, and a message is the one thing here that arrives
	 * in bulk.
	 */
	private async recordEpisode(
		chatId: string,
		text: string,
		tags: string[],
		at: number,
		metadata?: Record<string, string>,
	): Promise<void> {
		if (!this.deps.episodes) return;
		const body = text.trim();
		if (!body) return;
		const meta = this.chats.get(chatId);
		if (!meta?.userId) return;
		try {
			if (await this.isOwnerUserId(meta.userId)) return;
			const memory = await this.deps.memory.for(meta.userId);
			await memory.remember({
				text: body,
				entity: MEMORY_EPISODE_ENTITY,
				tags: ["episode", ...tags],
				validFrom: at,
				metadata: { chatId, ...metadata },
			});
			// Keyed by the name too, so a contact renamed in Telegram is joined to their
			// own log under the name the facts about them now carry.
			const edge = `${meta.userId} ${meta.contactName}`;
			if (!this.episodesLinked.has(edge)) {
				await memory.link(
					meta.contactName,
					MEMORY_EPISODE_RELATION,
					MEMORY_EPISODE_ENTITY,
				);
				this.episodesLinked.add(edge);
			}
		} catch (error) {
			// Never at the cost of the conversation — but not in silence either.
			this.reportMemoryError(error);
		}
	}

	/** Whether a userId is the business owner (never store contact facts for them). */
	private async isOwnerUserId(userId: string): Promise<boolean> {
		const connections = await this.deps.businessStore.all();
		return connections.some((connection) => connection.userId === userId);
	}

	/**
	 * Mark a chat as a consolidation candidate, refreshing its quiet timer.
	 *
	 * Unless the memory pass has already been over everything up to `activityAt`. This
	 * one line is what makes a restart free: activation seeds every stored transcript
	 * back into the queue (that is what makes memory survive a restart at all), stamped
	 * with its real last-activity time — which, for a conversation that ended
	 * yesterday, is long past the quiet threshold and therefore eligible AT ONCE. With
	 * no record of what had already been read, the whole interrogation ran again, on
	 * the same messages, every single launch. The facts were deduplicated on write, so
	 * nothing was corrupted; it simply cost a full pass of inference per chat, forever.
	 *
	 * A chat with genuinely new messages has activity past the cursor and is queued as
	 * it always was.
	 */
	private async touchConsolidation(
		chatId: string,
		activityAt: number,
	): Promise<void> {
		const userId = this.chats.get(chatId)?.userId;
		if (!userId) return; // nothing to remember without a known contact
		const cursor = await this.deps.chatCursors.get(chatId);
		const consolidated = cursor?.consolidatedThrough;
		if (consolidated !== undefined && activityAt <= consolidated) return;
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
		// Resume a pass that was paused for live work before starting a new one. The
		// ledger comes with it, so the model is handed back what it already did rather
		// than starting the conversation over.
		if (this.pausedConsolidation) {
			// Resumed, but with a refreshed window: the transcript grew while the pass was
			// parked, and the pass will be credited with everything it can now see.
			this.consolidating = {
				...this.pausedConsolidation,
				...(await this.loadConsolidationWindow(
					this.pausedConsolidation.chatId,
				)),
			};
			this.pausedConsolidation = null;
			this.consolidating.ledger.startTurn();
			await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
			return;
		}
		const entry = await this.deps.consolidationQueue.eligible(
			this.deps.clock.now(),
			this.deps.factConsolidationQuietMs,
		);
		if (!entry) return;
		// Decide "is this the owner talking to themselves?" in CODE, by userId, before
		// the model is involved at all — a namesake can never be mistaken for the owner
		// (or vice versa) the way name-based reasoning would. A self-chat has no
		// interlocutor to remember, so drop it from the queue and stop.
		if (entry.userId && (await this.isOwnerUserId(entry.userId))) {
			await this.deps.consolidationQueue.remove(entry.chatId);
			return;
		}
		// Consolidation is strictly below conversation work, including work that is
		// old by the time we notice it. A message can be stale because the manager
		// was already running when it arrived; it is still unanswered, and sending
		// the chat to a memory pass first is exactly how a pending conversation got
		// mistaken for a finished one. Move it back into the ordinary scheduler and
		// let the model decide how to handle the late message.
		if (await this.hasSomethingToAnswer(entry.chatId)) {
			this.unserved.add(entry.chatId);
			this.scheduler.onMessage(entry.chatId);
			await this.triggerTurn();
			return;
		}
		const ledger = new MemoryLedger();
		ledger.startTurn();
		this.consolidating = {
			chatId: entry.chatId,
			userId: entry.userId,
			ledger,
			...(await this.loadConsolidationWindow(entry.chatId)),
		};
		// A pass makes no chat decision, so it must not inherit one either: a sink still
		// holding the last reply turn's answer would be read by whatever ends this run.
		this.decision.reset();
		this.resolve.reset();
		await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
	}

	/**
	 * Patch a chat's in-memory meta with the interlocutor's userId taken from the
	 * transcript, when the meta exists but has no userId yet. The userId is the key
	 * for a contact's durable facts, but the in-memory chats map is empty after a
	 * restart until a fresh live message repopulates it — so without this, facts for
	 * a chat recovered by catch-up would be neither shown nor stored. The stored
	 * `senderId` on an interlocutor record is exactly that id.
	 */
	private rememberUserId(
		chatId: string,
		records: readonly ChatMessageRecord[],
	): void {
		const meta = this.chats.get(chatId);
		if (!meta || meta.userId) return;
		for (let i = records.length - 1; i >= 0; i -= 1) {
			const record = records[i];
			if (record.author === "interlocutor" && record.senderId) {
				this.chats.set(chatId, { ...meta, userId: record.senderId });
				return;
			}
		}
	}

	/**
	 * Record that this chat has been dealt with up to its newest interlocutor message —
	 * the durable twin of `unserved.delete()`.
	 *
	 * Their newest message, not the newest message: a reply of ours, or a line the owner
	 * typed, is not something anyone is waiting on us for. And it is read from the
	 * transcript rather than remembered in the meta, because the meta is empty after a
	 * restart, while the transcript is the thing catch-up will be judging.
	 */
	private async markHandled(chatId: string): Promise<void> {
		const records = await this.deps.chatStore.getRecent(
			chatId,
			this.deps.rememberMessages,
		);
		const { lastInterlocutorAt } = analyzeChat(records);
		if (lastInterlocutorAt === null) return;
		await this.deps.chatCursors.markHandled(chatId, lastInterlocutorAt);
	}

	/**
	 * How far into a chat a memory pass can see.
	 *
	 * `coveredThrough` is the newest message in the window — every author, not just the
	 * interlocutor's — because it answers "how much of this conversation has been
	 * looked at", not "what may be remembered". A pass that saw the bot's reply has
	 * been over that reply too, and must not be asked to look again. Written to the
	 * chat's cursor when the pass ends; without it, every launch re-read every stored
	 * transcript from the beginning and paid a full pass of inference to conclude
	 * nothing had changed.
	 */
	private async loadConsolidationWindow(
		chatId: string,
	): Promise<{ coveredThrough: number }> {
		const records = await this.deps.chatStore.getRecent(
			chatId,
			this.deps.rememberMessages,
		);
		const coveredThrough = records.reduce(
			(newest, record) => Math.max(newest, record.timestamp),
			0,
		);
		return { coveredThrough };
	}

	/**
	 * Handle the end of a memory pass's agent run.
	 *
	 * A pass walks its whole loop inside one run (`stepConsolidation` settles each
	 * sample at `turn_end`), so by the time the run stops there are only three things
	 * it can mean:
	 *
	 *  - the model called `telegram_manager_done`, or the runtime stopped a pass that would not
	 *    stop itself → finalize;
	 *  - live conversation work appeared → PARK the pass, ledger and all, and serve the
	 *    person who is waiting; it resumes from exactly here once idle;
	 *  - the run ended for some other reason with the pass unfinished → finalize
	 *    anyway.
	 *
	 * That last case is where this differs from the design it replaced, which
	 * restarted the run to ask the next question. There is no next question now, and
	 * nothing to recover: every memory tool has already written what it did. Starting
	 * a fresh run would buy another inference for a pass the model has stopped
	 * engaging with — the chat's cursor records how far this one read, and whatever is
	 * left is the next pass's to find.
	 */
	private async finishConsolidationRun(): Promise<void> {
		const current = this.consolidating;
		if (!current) return;
		// Pre-empted by live work: park here (nothing is lost) and serve the reply.
		if (!current.ledger.isFinished() && this.unserved.size > 0) {
			this.pausedConsolidation = current;
			this.consolidating = null;
			await this.triggerTurn();
			return;
		}
		await this.finalizeConsolidation(current);
	}

	/**
	 * Close a pass: clear the state, drop the chat from the queue, record how far it
	 * read, and serve anything that queued while it ran.
	 *
	 * There are no facts to write here. Every one of them was written by the tool that
	 * decided it, at the moment it decided it — which is what makes a pass safe to cut
	 * off at any point, and what makes this function short.
	 */
	private async finalizeConsolidation(
		current: ConsolidationPass,
	): Promise<void> {
		this.consolidating = null;
		// A memory pass makes no chat decision, so it must leave none behind. It should
		// not be able to record one at all (`tool-gate.ts` takes the reply tools away on
		// this turn) — but a sink that outlives the turn that filled it is a landmine,
		// and the next turn to read it would be somebody else's.
		this.decision.reset();
		this.resolve.reset();
		await this.deps.consolidationQueue.remove(current.chatId);
		// Say so on disk, or the next launch will read the same conversation again.
		// Recorded even when the pass changed nothing — "there was nothing here worth
		// remembering" is a conclusion, and it cost a pass of inference to reach.
		if (current.coveredThrough > 0) {
			await this.deps.chatCursors.markConsolidated(
				current.chatId,
				current.coveredThrough,
			);
		}
		await this.triggerTurn();
	}
}
