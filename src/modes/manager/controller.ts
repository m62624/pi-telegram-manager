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
 * the model's `manager_reply` text is delivered on behalf of the owner (tagged so
 * the bot never mistakes its own send for the owner); `manager_silent` releases
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
import {
	type ChatMessageRecord,
	type ChatStore,
	ownWords,
} from "../../storage/chat-store";
import {
	type ContactFact,
	type ContactStore,
	capFacts,
	dedupeFacts,
	type FactKind,
} from "../../storage/contact-store";
import { describeAttachments, isImage } from "../../telegram/media";
import { extractMessageContext } from "../../telegram/message-context";
import { extractProfileFromUser } from "../../telegram/profile";
import {
	boundaryDirective,
	buildIsolatedMessages,
	type IsolatedImage,
	type IsolatedMessage,
	windowRecords,
} from "./context-isolation";
import { analyzeChat, type ConversationState } from "./conversation-state";
import {
	DecisionState,
	DraftResolutionState,
	FactState,
	type MessageCategory,
	resolveDecision,
} from "./decision";
import { isBotMessage, stripBotMarker } from "./identity";
import {
	advance as advanceInterrogation,
	currentProbe,
	droppedFacts,
	finalFacts,
	type InterrogationState,
	initInterrogation,
	isDone,
	type KnownFact,
	ProbeState,
} from "./interrogation";
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
	"one tool — manager_reply to answer, or manager_silent to stay quiet and keep " +
	"observing. You may also call manager_remember first to save a durable fact. " +
	"Never write plain text and never write a tool name as text. No draft is held " +
	"right now, so manager_resolve_draft does NOT apply this turn — calling it " +
	"fails.]";

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
 * The same job for a consolidation pass — and it needs its own words, because the one
 * above is written for a turn that ends in a DECISION, and a memory pass does not have
 * one.
 *
 * Reused verbatim, it told a model in the middle of a background memory review that it
 * "had already decided this turn". Reading that, with the reply tools still in its list
 * (a separate bug, now fixed in `tool-gate.ts`) and a transcript ending in somebody's
 * question, the model concluded it was answering that person — "I already replied", it
 * wrote, and then produced a word of prose for a chat it was never talking to. In other
 * passes it went looking for the interrogation step that the standing prompt above still
 * demanded, found none, and called step one again until the run was aborted.
 *
 * A directive that ends a turn has to say what KIND of turn it is ending.
 */
export const CONSOLIDATION_DONE =
	"[The memory pass for this contact is finished: every step has been answered and " +
	"there is nothing left to do. You are not replying to anyone — no tool, no message. " +
	"Reply with a single word to end the turn.]";

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
		"manager_reply and manager_silent are DISABLED this turn — calling either " +
		"fails and wastes the turn. The ONE tool that ends this turn is " +
		"manager_resolve_draft (it IS available, whatever you assume about your tool " +
		"list):\n" +
		'  manager_resolve_draft {"action": "send"} — deliver the draft unchanged;\n' +
		'  manager_resolve_draft {"action": "refine", "text": "<full final message>"} — ' +
		"deliver a rewrite that starts from the draft and folds in the new info;\n" +
		'  manager_resolve_draft {"action": "drop"} — ONLY if they retracted the ' +
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
		"wrong way — the interlocutor has NOT seen it. It is not lost: it is held as a " +
		"draft, and this turn decides what happens to it.\n" +
		"manager_reply and manager_silent are DISABLED this turn — calling either fails " +
		"and wastes the turn. The ONE tool that ends this turn is manager_resolve_draft " +
		"(it IS available, whatever you assume about your tool list):\n" +
		'  manager_resolve_draft {"action": "send"} — deliver that text as-is (usually ' +
		"the right call);\n" +
		'  manager_resolve_draft {"action": "refine", "text": "<full final message>"} — ' +
		"deliver a corrected version of it;\n" +
		'  manager_resolve_draft {"action": "drop"} — ONLY if it was not meant as a ' +
		"message to the interlocutor (e.g. it was just your own reasoning).\n" +
		"A real question deserves its answer — do not drop it as chatter.]"
	);
}

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
	"long-term memory about this specific person. Nobody is waiting for you and " +
	"nothing you write reaches Telegram: the reply tools do not exist on this turn, " +
	"and a question left standing in the transcript below is one you have already " +
	"answered, or one that is not yours to answer now. Work strictly about the " +
	"interlocutor, never the owner or the bot. Answer only the numbered interrogation " +
	"step shown below, calling the one tool it names.";

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
	contactStore: ContactStore;
	consolidationQueue: ConsolidationQueue;
	/** How far each chat has been answered and consolidated — see `chat-state`. */
	chatCursors: ChatCursorStore;
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
	private readonly resolve = new DraftResolutionState();
	private readonly facts = new FactState();
	private readonly probes = new ProbeState();
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
	 * The chat currently being memory-consolidated (idle pass), if any, together
	 * with the interrogation state machine driving its per-probe questions.
	 */
	private consolidating: {
		chatId: string;
		userId?: string;
		loop: InterrogationState;
		/**
		 * The interlocutor's own transcript lines, captured at consolidation start
		 * for the per-fact evidence check. Cached so the interrogation can step
		 * SYNCHRONOUSLY from `turn_end` (no async chatStore read mid-run); the
		 * transcript is static while an idle consolidation runs.
		 */
		interlocutorLines: string[];
		/**
		 * The newest message this pass can see. Written to the chat's cursor when the
		 * pass finishes, and it is what stops the whole interrogation being run again,
		 * from scratch, on the same messages, at every launch.
		 */
		coveredThrough: number;
	} | null = null;
	/**
	 * A consolidation paused mid-interrogation because live conversation work
	 * appeared. Its progress (the interrogation step reached) is preserved here and
	 * resumed — from exactly where it left off, not restarted — by
	 * {@link maybeStartConsolidation} once the manager is idle again. Distinct from
	 * {@link consolidating} so a live turn's termination is judged on the reply
	 * decision, not a stale probe.
	 */
	private pausedConsolidation: {
		chatId: string;
		userId?: string;
		loop: InterrogationState;
		interlocutorLines: string[];
		coveredThrough: number;
	} | null = null;
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

	/** The per-turn fact sink the memory tool writes into. */
	factSink(): FactState {
		return this.facts;
	}

	/** The per-probe sink the interrogation tools write into (consolidation). */
	probeSink(): ProbeState {
		return this.probes;
	}

	/** The per-turn sink the resolve-draft tool writes into (revise turns). */
	resolveSink(): DraftResolutionState {
		return this.resolve;
	}

	/**
	 * Whether the active chat is on a REVISE turn: a reply is held (either drafted
	 * last turn and held because new interlocutor messages landed, or recovered from a
	 * plain-text turn) and the model must now resolve it (send/refine/drop). Public so
	 * the tool matcher can reveal manager_resolve_draft only on these turns (and hide it
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
	 * turn-type specific: a normal turn ends on reply/silent (a bare
	 * manager_remember does NOT end it — the model may still reply); a consolidation
	 * probe ends as soon as its interrogation tool has been called.
	 */
	turnDecided(): boolean {
		if (this.consolidating) {
			// A consolidation "turn" spans the WHOLE interrogation now (one agent run
			// walking identify -> candidates -> verify×N). It is decided only when the
			// interrogation reaches `done`, at which point the context shows
			// MANAGER_TURN_DONE so the model ends the run with one word.
			return isDone(this.consolidating.loop);
		}
		// Revise turn: the gate ends the turn ONLY when the model resolved the held
		// draft — a plain manager_reply/manager_silent must not complete it, so a
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
	 * Whether the running memory pass has answered every step and is only waiting for
	 * the run to end. Public so the tool gate can take the probes away: a finished pass
	 * has no step left to answer, and a model that can still see step one's tool will
	 * call step one again (it did — every pass, until the runtime aborted the run).
	 */
	isConsolidationDone(): boolean {
		return this.consolidating !== null && isDone(this.consolidating.loop);
	}

	/**
	 * Step the consolidation interrogation at a `turn_end`, WITHIN one agent run.
	 * Reads the probe the model just called, advances the state machine, and tells
	 * the caller whether to abort the run:
	 *
	 *  - `"abort"` — the interrogation just answered its last step (end the run: see
	 *    below), live conversation work is now waiting (pre-empt at once; the run is
	 *    paused and resumed later), or the model kept calling tools after the
	 *    interrogation was already done (backstop against a spin);
	 *  - `"continue"` — let the agent loop re-sample; `pi.on("context")` rebuilds the
	 *    context showing the next probe's directive, so the whole interrogation flows
	 *    in a single run with no per-probe abort.
	 *
	 * A pass used to end one LLM call later than this: the last probe answered, the tool
	 * gate withdrew the probes (a finished pass that can still see step one's tool calls
	 * step one — it did), and the model was sampled once more with an empty tool list so
	 * that it could say a word and stop. That word was never read by anything. It cost a
	 * whole inference — and worse, withdrawing the tools rewrites the head of the prompt,
	 * which is the prefix every backend caches, so the closing call re-read the entire
	 * interrogation from byte zero. Once per pass, and the owner watched the prefix
	 * watchdog (`core/payload-probe.ts`) report it as the defect it was.
	 *
	 * So the run ends where the questions end. Nothing is lost by stopping here: every
	 * confirmed fact is already on disk ({@link persistConfirmed} writes each one the
	 * moment it passes verification), and `agent_end` reaches
	 * {@link finishConsolidationRun}, which sees `isDone` and finalizes exactly as it
	 * does for a pass that ends any other way.
	 *
	 * Async because a fact that has just passed verification is WRITTEN here, before the
	 * next step is taken — see {@link persistConfirmed}.
	 */
	async stepConsolidation(): Promise<"continue" | "abort"> {
		const current = this.consolidating;
		if (!current) return "continue";
		const probe = this.probes.current();
		if (isDone(current.loop)) {
			// Already finished and the run is somehow still going (a queued message can
			// skip the step below, leaving the pass unsettled for a turn). If the model
			// called another tool anyway, abort as a backstop against a spin.
			return probe ? "abort" : "continue";
		}
		// Preserve this turn's progress (a recorded probe) BEFORE possibly yielding, so
		// a live pre-empt never discards a completed step — it resumes from the next.
		if (probe) {
			const loop = advanceInterrogation(
				current.loop,
				probe,
				current.interlocutorLines,
				this.deps.verifyLimit,
			);
			this.consolidating = { ...current, loop };
			this.probes.reset();
			await this.persistConfirmed(current.loop, loop, current);
			await this.persistDropped(current.loop, loop, current);
			// The last question has been answered. There is nothing left to ask and
			// nothing left to say: stop, rather than pay for a call whose only job is to
			// end the turn.
			if (isDone(loop)) return "abort";
		}
		// A reply is now waiting: yield so a live answer is never delayed by an
		// in-flight consolidation. onAgentEnd pauses the pass (progress kept).
		if (this.unserved.size > 0) return "abort";
		return "continue";
	}

	/**
	 * Write the facts this step just confirmed — now, not at the end of the pass.
	 *
	 * A fact reaches `confirmed` only after the model verified it against a quote that
	 * code found in the interlocutor's own lines. It is knowledge at that moment. Holding
	 * it in memory until the whole interrogation finishes made it hostage to everything
	 * that can end a pass early: an interlocutor writing mid-pass (pre-empt), the run
	 * being aborted, the bot being restarted. All of it was dropped, the chat stayed in
	 * the queue, and the next pass asked the same questions from step one — which is
	 * exactly what the owner saw: "I thought it had already saved fact, fact, fact".
	 *
	 * Written per fact, the worst an interruption can now cost is the candidates that
	 * were not verified yet. Re-running the pass re-confirms what is already stored, and
	 * the store drops the repeat (`contact-store.appendFacts` dedupes) — so a fact is
	 * written once, however many times it is learned.
	 */
	private async persistConfirmed(
		before: InterrogationState,
		after: InterrogationState,
		current: { chatId: string; userId?: string },
	): Promise<void> {
		const fresh = after.confirmed.slice(before.confirmed.length);
		if (fresh.length === 0) return;
		for (const fact of fresh) {
			this.facts.record([
				{ text: fact.text, subject: "interlocutor", kind: fact.kind },
			]);
		}
		const contactName = this.chats.get(current.chatId)?.contactName;
		await this.persistRecordedFacts(current.userId, contactName);
	}

	/**
	 * What is remembered about a contact right now, exactly as the model is shown it —
	 * deduped, and capped the way the store caps itself.
	 *
	 * The review step is asked about THIS list by number, so it has to be the same list,
	 * built the same way. A fact the model cannot see is a fact it cannot be asked about.
	 */
	private async rememberedFacts(
		userId: string | undefined,
	): Promise<KnownFact[]> {
		if (!userId) return [];
		const stored = await this.deps.contactStore.getFacts(userId);
		return capFacts(dedupeFacts(stored), this.deps.factsLimit).map((fact) => ({
			text: fact.text,
			kind: fact.kind,
		}));
	}

	/**
	 * Unlearn what this step just overturned — now, not at the end of the pass, and for
	 * the same reason {@link persistConfirmed} writes a fact the moment it is confirmed:
	 * a pass can be pre-empted, aborted or restarted at any step, and a decision held in
	 * memory until the end is a decision that gets lost.
	 *
	 * A fact only reaches `dropped` after the model named it AND code found, in the
	 * interlocutor's own lines, the sentence that overturns it. So this deletes nothing
	 * the person did not themselves say was no longer true.
	 */
	private async persistDropped(
		before: InterrogationState,
		after: InterrogationState,
		current: { userId?: string },
	): Promise<void> {
		const fresh = after.dropped.slice(before.dropped.length);
		if (fresh.length === 0 || !current.userId) return;
		if (await this.isOwnerUserId(current.userId)) return;
		await this.deps.contactStore.removeFacts(
			current.userId,
			fresh.map((fact) => fact.text),
		);
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
			// A dropped forward still counts as the owner speaking (the gate below), it
			// simply leaves no body in the transcript.
			if (!forwardDropped || forward?.justHitLimit) {
				await this.deps.chatStore.append(chatId, {
					author: "owner",
					text: forwardBody(stripBotMarker(text)),
					context: messageContext(input.message),
					forwarded: input.message.forward_origin !== undefined,
					timestamp: messageTime,
					senderId: ownerId,
					messageId,
				});
			}
			await this.touchConsolidation(chatId, messageTime);
			// An explicit wake-word from the owner summons the bot, even though it never
			// acts on owner messages otherwise. This is the ONE way an owner message
			// opens a turn — and the only way the model may answer the owner at all.
			// A stale/backlog message never wakes.
			if (
				now - messageTime <= this.deps.liveFreshnessMs &&
				matchesMention(text, this.deps.mentionWords)
			) {
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
			// model a revise turn (`manager_resolve_draft`: send / refine / drop). Note
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
			? { note: "", kind: undefined }
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
				if (loaded.length > 0) {
					const pending = this.latestImages.get(chatId) ?? [];
					const merged = [...pending, ...loaded];
					const cap = this.deps.maxImages;
					this.latestImages.set(
						chatId,
						cap && merged.length > cap ? merged.slice(-cap) : merged,
					);
				}
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
		// A consolidation run ended — finalize, pause, or resume it (no reply sent).
		if (this.consolidating) {
			await this.finishConsolidationRun();
			return null;
		}
		const active = this.scheduler.activeChat();
		if (active === null) {
			this.facts.reset();
			return null;
		}
		let text: string | null;
		let requestedReplyTo: number | undefined;
		let decisionKind: "reply" | "silent" | "none";
		let category: MessageCategory | undefined;
		let silentReason: string | undefined;
		let needsReply: boolean | undefined;
		// A REVISE turn: a held draft is pending, so the resolve-draft tool — not
		// manager_reply/manager_silent — carries the outcome (the gate guaranteed it
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
		// Persist any durable facts the model recorded mid-conversation.
		await this.persistRecordedFacts(meta?.userId, meta?.contactName);
		this.gate.clearServed(active);
		// The model ended in plain text without calling a tool. Plain text is never
		// delivered, so the reply was lost. Instead of re-deciding from scratch (a weak
		// model may relabel a real question as chatter, and the guard then drops the
		// answer), hold the prose as a draft and route it through the resolve-draft gate:
		// the model must explicitly send/refine/drop it, and an unresolved run sends it —
		// so a composed answer is never silently lost. A sent draft reads as a considered
		// reply (category question) and bypasses the chatter guard below.
		const prose = finalText?.trim();
		if (decisionKind === "none" && prose && !this.pendingReply.has(active)) {
			this.pendingReply.set(active, { text: prose, fromProse: true });
			await this.triggerTurn();
			return { ...contact, outcome: "corrected", text: prose };
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
		// So the rule is: above the transcript goes only what never changes; everything
		// that varies — the clock, the opener, the facts, the state, the directive —
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
				content: [
					this.nowLine(),
					opener,
					known,
					`${stateSummary(state)}${mentionHint}`,
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
		const probe = currentProbe(current.loop);
		// The review step hands the model its own memory, numbered, because it answers by
		// number. Showing the grouped block underneath it as well would put the same facts
		// in front of the model twice, in two different shapes, on the one step where it
		// has to point at exactly one of them.
		const known =
			probe.tool === "manager_forget" ? "" : await this.knownFactsBlock(meta);
		// Constant above the transcript, everything that varies below it — the same rule as
		// `buildContextForActive`, and for the same measured reason. The facts block is the
		// most volatile thing in a consolidation (it is what the pass EXISTS to change), so
		// it is the last thing that may sit on top of the conversation.
		const system = `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${CONSOLIDATION_INSTRUCTIONS}`;
		const directive = this.turnDecided() ? CONSOLIDATION_DONE : probe.directive;
		return [
			{ role: "user", content: system },
			...isolated,
			{
				role: "user",
				content: [this.nowLine(), known, directive]
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
	 * reaches here from {@link onAgentEnd} — a run cannot take a prompt while it is
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
		// A revise turn names the only tool that can end it: reply/silent are hidden
		// and blocked while a draft is held, so prompting for them wastes the turn.
		await this.deps.triggerAgent(
			this.pendingReply.has(active)
				? "A drafted reply is held for review in the active Telegram chat. Resolve it by calling manager_resolve_draft."
				: "Respond to the latest messages in the active Telegram chat by calling manager_reply or manager_silent.",
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
	 *  - a held draft awaiting `manager_resolve_draft`.
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
		return analyzeChat(records).interlocutorWaiting;
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
		const stored = await this.deps.contactStore.getFacts(meta.userId);
		if (stored.length === 0) return "";
		// Deduped BEFORE the cap, not after: a store written before the dedupe landed
		// still holds repeats, and slicing first would spend the budget on them — a
		// contact whose memory is one sentence three times, and whose fourth fact fell
		// off the end. Telling the model something twice does not make it truer.
		const facts = dedupeFacts(stored);
		// Capped the same way the store caps itself: least valuable first, age only as the
		// tie-break. Slicing the newest off the end would show the model a different memory
		// from the one it has — and drop the contact's name to make room for their mood.
		const recent = capFacts(facts, this.deps.factsLimit);
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
		// Resume a consolidation that was paused for live work before starting a new
		// one — continue from the exact interrogation step it reached, so nothing
		// already consolidated is redone.
		if (this.pausedConsolidation) {
			// Resume from the exact step reached, but refresh the window: the transcript
			// grew while the pass was paused for live work, and the pass will be credited
			// with everything it can now see.
			this.consolidating = {
				...this.pausedConsolidation,
				...(await this.loadConsolidationWindow(
					this.pausedConsolidation.chatId,
				)),
			};
			this.pausedConsolidation = null;
			this.facts.reset();
			this.probes.reset();
			await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
			return;
		}
		const entry = await this.deps.consolidationQueue.eligible(
			this.deps.clock.now(),
			this.deps.factConsolidationQuietMs,
		);
		if (!entry) return;
		// Decide "is this the owner talking to themselves?" in CODE, by userId, before
		// the model ever runs the identify probe — a namesake can never be mistaken for
		// the owner (or vice versa) the way name-based reasoning would. A self-chat has
		// no interlocutor to remember, so drop it from the queue and stop.
		if (entry.userId && (await this.isOwnerUserId(entry.userId))) {
			await this.deps.consolidationQueue.remove(entry.chatId);
			return;
		}
		const contactName =
			this.chats.get(entry.chatId)?.contactName ?? entry.chatId;
		this.consolidating = {
			chatId: entry.chatId,
			userId: entry.userId,
			// What is already remembered goes INTO the interrogation, not just alongside it:
			// the review step is asked about this exact list, and its numbers index into it.
			loop: initInterrogation(
				contactName,
				await this.rememberedFacts(entry.userId),
			),
			...(await this.loadConsolidationWindow(entry.chatId)),
		};
		this.facts.reset();
		this.probes.reset();
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
	 * What a memory pass reads: the interlocutor's own lines (the evidence a fact must
	 * be quoted from) and how far into the chat those lines go.
	 *
	 * Their OWN words only. A reply quotes the message it answers and a forward carries
	 * a stranger's text: both used to sit inside the interlocutor's stored line, so the
	 * evidence check confirmed "facts" about them out of words the owner or the bot had
	 * written.
	 *
	 * `coveredThrough` is the newest message in the window — every author, not just
	 * theirs — because it answers a different question: not "what may be remembered"
	 * but "how much of this chat has been looked at". A pass that saw the bot's reply
	 * has been over that reply too, and must not be asked to look again.
	 */
	private async loadConsolidationWindow(
		chatId: string,
	): Promise<{ interlocutorLines: string[]; coveredThrough: number }> {
		const records = await this.deps.chatStore.getRecent(
			chatId,
			this.deps.rememberMessages,
		);
		const interlocutorLines = records
			.filter((record) => record.author === "interlocutor")
			.map((record) => ownWords(record))
			.filter((line) => line.length > 0);
		const coveredThrough = records.reduce(
			(newest, record) => Math.max(newest, record.timestamp),
			0,
		);
		return { interlocutorLines, coveredThrough };
	}

	/**
	 * Handle the end of a consolidation agent run. The interrogation now advances
	 * step-by-step WITHIN one run (see {@link stepConsolidation} in `turn_end`), so
	 * this run-boundary handler only decides what to do now that the run stopped:
	 *
	 *  - the interrogation is `done` → persist the confirmed facts (through the
	 *    who-is-who firewall) and drop the chat from the consolidation queue;
	 *  - live conversation work is waiting (the run was pre-empted for a reply) →
	 *    PAUSE, keeping the exact step reached, and hand the turn back to the chat;
	 *    consolidation resumes from here once idle again;
	 *  - the run ended early without finishing (the model produced no probe tool this
	 *    step) → safely progress the state machine one step (a missing result is
	 *    handled by {@link advance}, so the pass always terminates) and, unless that
	 *    reached `done`, continue the interrogation in a fresh run.
	 *
	 * Progress is never discarded: a completed step is kept and carried forward.
	 */
	private async finishConsolidationRun(): Promise<void> {
		const current = this.consolidating;
		if (!current) return;
		if (isDone(current.loop)) {
			await this.finalizeConsolidation(current);
			return;
		}
		// Pre-empted by live work: pause here (progress kept) and serve the reply.
		if (this.unserved.size > 0) {
			this.pausedConsolidation = current;
			this.consolidating = null;
			await this.triggerTurn();
			return;
		}
		// The run ended before finishing and nothing is waiting — the model produced
		// no probe for the current step. Progress the machine safely (a null result
		// ends identify/candidates and drops a single verify), so the pass can never
		// stall, then continue in a new run unless that already completed it.
		const next = advanceInterrogation(
			current.loop,
			this.probes.current(),
			current.interlocutorLines,
			this.deps.verifyLimit,
		);
		this.probes.reset();
		this.consolidating = { ...current, loop: next };
		if (isDone(next)) {
			await this.finalizeConsolidation(this.consolidating);
			return;
		}
		await this.deps.triggerAgent(CONSOLIDATION_PROMPT);
	}

	/**
	 * Persist a finished interrogation's confirmed facts (through the who-is-who
	 * firewall), clear consolidation state, drop the chat from the queue, and serve
	 * any reply that queued while it ran.
	 *
	 * Most of these facts are already on disk — {@link persistConfirmed} wrote each one
	 * the moment it passed verification, and {@link persistDropped} removed each one the
	 * moment it was overturned. This stays as the backstop for the path that does not go
	 * through a probe (a run that ended early, whose last step is settled here by
	 * {@link finishConsolidationRun}); redoing either is free — the store keeps one copy
	 * of a fact, and removing one that is already gone removes nothing.
	 */
	private async finalizeConsolidation(current: {
		chatId: string;
		userId?: string;
		loop: InterrogationState;
		coveredThrough: number;
	}): Promise<void> {
		this.consolidating = null;
		this.facts.reset();
		// A memory pass makes no chat decision, so it must leave none behind. It should
		// not be able to record one at all now (`tool-gate.ts` takes the reply tools away
		// on this turn) — but a sink that outlives the turn that filled it is a landmine,
		// and the next turn to read it would be somebody else's.
		this.decision.reset();
		this.resolve.reset();
		for (const fact of finalFacts(current.loop)) {
			this.facts.record([
				{ text: fact.text, subject: "interlocutor", kind: fact.kind },
			]);
		}
		const contactName = this.chats.get(current.chatId)?.contactName;
		// Unlearn BEFORE writing: a pass that overturns a fact and states its replacement
		// in the same breath must not have the replacement dropped as a duplicate of the
		// thing it replaces.
		const dropped = droppedFacts(current.loop);
		if (dropped.length > 0 && current.userId) {
			await this.deps.contactStore.removeFacts(
				current.userId,
				dropped.map((fact) => fact.text),
			);
		}
		await this.persistRecordedFacts(current.userId, contactName);
		await this.deps.consolidationQueue.remove(current.chatId);
		// Say so on disk, or the next launch will ask the same questions of the same
		// messages. Recorded even when the pass saved nothing — "there was nothing here
		// to remember" is a conclusion, and it took a full interrogation to reach it.
		if (current.coveredThrough > 0) {
			await this.deps.chatCursors.markConsolidated(
				current.chatId,
				current.coveredThrough,
			);
		}
		await this.triggerTurn();
	}
}
