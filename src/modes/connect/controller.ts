/**
 * Orchestrator for mode 1 (terminal continuation) over injected ports.
 *
 * It owns the message pump: an authorized Telegram message becomes a prompt
 * turn, is queued, and is released to the agent as a follow-up only while the
 * agent is idle (so our lane queue keeps its edit-by-source window instead of
 * handing everything straight to Pi). When a turn finishes, the assistant's
 * reply is mirrored back to the bound chat and the next queued turn is pumped.
 *
 * All Pi/grammY specifics arrive as ports (isIdle, sendFollowUp, OutboundSender,
 * AbortRegistry), so this pump is unit-testable; `index.ts` wires the ports to
 * real `pi.on` handlers and command context.
 */
import type { Message, User } from "@grammyjs/types";
import { COMPLIANCE_LINKS, COMPLIANCE_NOTICE } from "../../constants";
import type { AbortRegistry } from "../../core/abort";
import {
	DEFAULT_FORWARD_POLICY,
	ForwardBursts,
	type ForwardPolicy,
	forwardLimitNote,
	limitForwardText,
} from "../../core/forwards";
import { TERMINAL_ORIGIN_MARKER } from "../../core/prompt-origin";
import { MessageQueue, type QueueItem } from "../../core/queue";
import { buildPromptTurn, type TurnSavedFile } from "../../core/turns";
import { buildRichMarkdownMessage } from "../../telegram/markdown";
import type { OutboundSender, OutboundTarget } from "../../telegram/outbound";
import {
	buildRichHtmlMessage,
	type RichHtml,
} from "../../telegram/rich-builder";
import {
	type ToolCallActivity,
	toolActivityMessage,
} from "../../telegram/tool-activity";
import type { TelegramEvent } from "../../telegram/updates";
import { bullet, card, link, note } from "./format";
import {
	type InboundImage,
	isServiceMessage,
	lastAssistantReply,
	messageText,
	messageToTurnInput,
	type PromptContent,
	parseSlashCommand,
} from "./messages";

export interface ConnectControllerDeps {
	/** Only messages from this Telegram user are accepted (their private chat id). */
	allowedUserId: number;
	/** Attachment size cap for describing inbound media. */
	maxBytes: number;
	/** Whether the agent is currently idle (not streaming). */
	isIdle: () => boolean;
	/** Deliver a prompt turn to the agent as a follow-up (no interruption). */
	sendFollowUp: (content: PromptContent) => Promise<void>;
	/**
	 * The moment the bot first SPEAKS in a turn (its first draft chunk, tool block or
	 * answer), with the messages that turn answers. This — not the moment the prompt is
	 * handed to the agent — is when a message typed outside the personal topic is copied
	 * into it (see the topic router's `mirrorStraysIntoPersonal`): a copy that lands
	 * while the model is still thinking sits alone in the topic for seconds, which reads
	 * as the bot echoing you rather than answering you.
	 */
	onTurnVisible?: (sourceMessageIds: readonly number[]) => Promise<void>;
	/** Download an inbound message's image attachments as base64 (best-effort). */
	loadImages?: (message: Message) => Promise<InboundImage[]>;
	/**
	 * Download an inbound message's non-image files to disk and report their
	 * paths (plus any per-file errors) so the model can open and reason about
	 * them. Images are delivered inline via {@link loadImages}, not saved here.
	 */
	saveAttachments?: (
		message: Message,
	) => Promise<{ savedFiles: TurnSavedFile[]; errors: string[] }>;
	/**
	 * Upload a file to the bound chat so the user receives it (the reverse of
	 * `saveAttachments`). Exactly one of `path`/`url`. Throws on failure so the
	 * calling tool can surface the exact error to the model.
	 */
	uploadFile?: (input: {
		path?: string;
		url?: string;
		caption?: string;
	}) => Promise<void>;
	/** Handle a `/clear` (or `/new`, `/reset`) request to wipe the agent's history. */
	onClear?: () => Promise<void>;
	/** Handle a `/esc` (or `/cancel`) request to interrupt the running turn. */
	onAbort?: () => Promise<void>;
	/** Record/refresh the sender's profile in the contact store (best-effort). */
	onContact?: (user: User) => Promise<void>;
	/**
	 * The owner's `personal` topic, resolved per send (it appears once the router has
	 * created it, and vanishes again on a fallback to the plain DM). EVERYTHING of this
	 * conversation goes there — prompts, replies, and the tool calls the model made for
	 * the owner, which are part of watching it work, not manager noise. Undefined → the
	 * plain DM, i.e. the pre-topics behaviour.
	 */
	chatThread?: () => number | undefined;
	/**
	 * How many images one turn may carry (an album folds into a single turn). `0` or
	 * undefined = no cap; the reason to cap is a small local context, not any Pi limit.
	 */
	maxImages?: number;
	/**
	 * Quiet window that closes an album (Telegram delivers one message per photo, a
	 * few tens of ms apart). Default 1500 ms — long enough for a slow group, short
	 * enough that a single photo is not noticeably delayed.
	 */
	albumWindowMs?: number;
	/**
	 * Budget for FORWARDED messages — how much of a forward is read, and how many of
	 * one batch. Defaults to {@link DEFAULT_FORWARD_POLICY} when not injected.
	 */
	forwards?: ForwardPolicy;
	/** Timer ports, injected so album batching is testable without real time. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Clock port, injected so forward batching is testable without real time. */
	clock?: { now(): number };
	outbound: OutboundSender;
	abort: AbortRegistry;
}

/** See {@link ConnectControllerDeps.albumWindowMs}. */
export const DEFAULT_ALBUM_WINDOW_MS = 1500;

// Telegram bot commands the bridge handles itself instead of forwarding to the
// agent. Everything else (including /start) falls through as an ordinary prompt.
const CLEAR_COMMANDS = new Set(["clear", "new", "reset"]);
const ABORT_COMMANDS = new Set(["esc", "cancel"]);
const HELP_COMMANDS = new Set(["help"]);
const START_COMMANDS = new Set(["start"]);

/** The extension's repository and its Tangled mirror, shown in the help footer. */
export const REPO_URL = "https://github.com/m62624/pi-telegram-manager";
export const MIRROR_URL =
	"https://tangled.org/m62624.tngl.sh/pi-telegram-manager";

/** Static help shown for `/help`, mirroring the Telegram command menu. */
const HELP_TEXT = card("🧭", "Pi Telegram bridge", [
	bullet("/switch", "change mode — manager / personal / mixed"),
	bullet("/stop", "stop the bot entirely"),
	bullet("/esc", "cancel the current turn"),
	bullet("/clear", "clear the conversation history"),
	bullet("/start", "privacy & terms — read before using"),
	bullet("/help", "show this help"),
	"",
	note(
		"Terminal commands (/telegram-personal, -manager, -mixed) run in Pi, not here.",
	),
	`⚠️ Terms you must follow: ${link("bot developers", COMPLIANCE_LINKS.botTerms)} · ${link("privacy", COMPLIANCE_LINKS.privacy)} · ${link("secretary/business", COMPLIANCE_LINKS.business)}`,
	`This bot runs ${link("pi-telegram-manager", REPO_URL)} · ${link("mirror", MIRROR_URL)}`,
]);

export class ConnectController {
	private readonly queue = new MessageQueue();
	private turnCounter = 0;
	/** Non-zero id of the current streaming draft; 0 when none is active. */
	private draftId = 0;
	/** Monotonic source of draft ids, so each message animates as its own draft. */
	private draftCounter = 0;
	/** Tool cards awaiting their outcome: toolCallId → the message to edit, and what it said. */
	private readonly toolCards = new Map<
		string,
		{ messageId: number; activity: ToolCallActivity }
	>();
	/** Albums still being collected: media_group_id → the queued turn it folds into. */
	private readonly albums = new Map<string, string>();
	private readonly albumTimers = new Map<string, unknown>();
	/** The open forward batch, so a burst of forwards reaches the model as one turn. */
	private readonly forwards: ForwardBursts;

	constructor(private readonly deps: ConnectControllerDeps) {
		this.forwards = new ForwardBursts(this.forwardPolicy);
	}

	private get forwardPolicy(): ForwardPolicy {
		return this.deps.forwards ?? DEFAULT_FORWARD_POLICY;
	}

	private now(): number {
		return this.deps.clock?.now() ?? Date.now();
	}

	/** Fold a line into an open batch, or open a new turn with it. */
	private async appendOrEnqueue(
		groupId: string,
		text: string,
		sourceMessageId: number,
	): Promise<void> {
		const open = this.albums.get(groupId);
		if (
			open !== undefined &&
			this.queue.appendToItem(open, { text, sourceMessageId })
		) {
			this.armAlbumFlush(groupId);
			return;
		}
		const id = `turn-${this.turnCounter++}`;
		this.queue.enqueue({
			id,
			lane: "default",
			text,
			sourceMessageIds: [sourceMessageId],
		});
		this.albums.set(groupId, id);
		this.armAlbumFlush(groupId);
	}

	private get target(): OutboundTarget {
		return {
			chatId: this.deps.allowedUserId,
			messageThreadId: this.deps.chatThread?.(),
		};
	}

	/**
	 * The running turn's source messages, until the bot first speaks (see
	 * {@link ConnectControllerDeps.onTurnVisible}). Null once they have been handed over
	 * — one turn copies its prompt once.
	 */
	private pendingMirror: readonly number[] | null = null;

	/** Hand the turn's prompt over right before the first thing the bot says. */
	private async flushMirror(): Promise<void> {
		const sources = this.pendingMirror;
		if (!sources) return;
		this.pendingMirror = null;
		await this.deps.onTurnVisible?.(sources);
	}

	/**
	 * Deliver the model's text into the personal topic.
	 *
	 * A message the owner typed in another topic is not answered where it was typed:
	 * Telegram cannot move it, and quoting it across topics is not something the
	 * clients agree on (phone, desktop and web each rendered the quote differently,
	 * and each was wrong in its own way). Instead the message itself is FORWARDED
	 * into the personal topic before the model sees it (see the topic router), so the
	 * conversation there stays whole and the answer needs no trick at all.
	 */
	private async sendAnswer(text: string): Promise<void> {
		await this.flushMirror();
		await this.deps.outbound.sendMarkdown(this.target, text);
	}

	/** Handle an inbound Telegram event. Returns true when it enqueued/edited a turn. */
	async onEvent(event: TelegramEvent): Promise<boolean> {
		if (event.kind !== "message" && event.kind !== "edited_message")
			return false;
		if (event.fromId !== this.deps.allowedUserId) return false;
		// A service message (you created a topic, pinned something) has no content: it
		// is not a prompt, and forwarding it woke the model with an empty turn.
		if (isServiceMessage(event.message)) return false;

		// Capture/refresh the sender's profile (name, username, …) for the contact
		// store — used now for a unified record and later relayed by the manager.
		if (this.deps.onContact && event.message.from) {
			void this.deps.onContact(event.message.from).catch(() => {});
		}

		// Intercept the bridge's own control commands (e.g. /clear) so they never
		// reach the agent as a prompt. Unknown commands (and /start, /help) fall
		// through and are treated as ordinary messages.
		if (await this.tryControlCommand(event.message)) return true;

		// Acknowledge receipt immediately with a "typing…" hint, before the agent
		// even starts (there is queue/dispatch latency in between).
		void this.sendTyping();

		// A FORWARD is a batch, not a message: forwarding five posts sends five
		// messages, each of any length. They are one act — so they fold into one turn
		// (like an album), and their bodies are capped by the forward budget, which is
		// separate from the ordinary message policy on purpose.
		const forward = this.forwards.track(
			String(this.deps.allowedUserId),
			event.message.forward_origin !== undefined,
			this.now(),
			event.message.media_group_id,
		);
		if (forward?.overLimit) {
			// Past the batch limit: the body is not read. Say so once, then drop the rest
			// in silence — repeating the note would be the flood the limit exists to stop.
			// The note joins the batch's own turn (its album, when it is one), so it is
			// read next to what WAS forwarded rather than as a turn of its own.
			if (forward.justHitLimit) {
				await this.appendOrEnqueue(
					event.message.media_group_id ?? forward.key,
					forwardLimitNote(this.forwardPolicy.maxMessages),
					event.message.message_id,
				);
			}
			return true;
		}

		// Save non-image files to disk (best-effort) so the model gets real paths;
		// images ride along inline via loadImages.
		const intake = await this.saveAttachments(event.message);
		const input = messageToTurnInput(event.message, this.deps.maxBytes);
		const turn = buildPromptTurn({
			...input,
			text:
				forward && input.text
					? limitForwardText(input.text, this.forwardPolicy.maxChars)
					: input.text,
			savedFiles: intake.savedFiles.length > 0 ? intake.savedFiles : undefined,
			attachmentErrors: intake.errors.length > 0 ? intake.errors : undefined,
		});

		if (
			event.kind === "edited_message" &&
			this.queue.editBySource(event.message.message_id, turn)
		) {
			return true; // still queued — rewrote it in place, no new dispatch
		}

		const images = await this.loadImages(event.message);

		// An ALBUM is not one message: Telegram splits it into one message per photo
		// (sharing a media_group_id), with your caption only on the first. Enqueued as
		// they arrive, five pictures became five turns — the model answering each
		// picture alone, four of them without your words. So an album is collected into
		// ONE turn: the first message opens it, the rest fold into it while it is still
		// queued, and it is dispatched once the group stops growing. A forward batch is
		// held open the same way, keyed by its burst instead of a media group.
		const groupId = event.message.media_group_id ?? forward?.key;
		if (groupId !== undefined) {
			const open = this.albums.get(groupId);
			if (open !== undefined) {
				const folded = this.queue.appendToItem(open, {
					maxImages: this.deps.maxImages,
					// Only the first message of an album carries your caption; the rest add
					// nothing but their picture, so their bare "[photo]" header is dropped.
					// Every forwarded message, by contrast, carries its own body — that IS
					// the content you forwarded, so all of them are kept.
					text:
						event.message.media_group_id === undefined || event.message.caption
							? turn
							: undefined,
					images,
					sourceMessageId: event.message.message_id,
				});
				if (folded) {
					this.armAlbumFlush(groupId);
					return true;
				}
				this.albums.delete(groupId);
			}
		}

		const id = `turn-${this.turnCounter++}`;
		this.queue.enqueue({
			id,
			lane: "default",
			text: turn,
			images: images.length > 0 ? images : undefined,
			sourceMessageIds: [event.message.message_id],
		});
		if (groupId !== undefined) {
			// Hold the album open: dispatch waits until no further photo has arrived for
			// `albumWindowMs`, so the whole group reaches the model in one turn.
			this.albums.set(groupId, id);
			this.armAlbumFlush(groupId);
			return true;
		}
		await this.dispatch();
		return true;
	}

	/** (Re)start the quiet window that closes an album and releases it to the agent. */
	private armAlbumFlush(groupId: string): void {
		const setTimer =
			this.deps.setTimer ??
			((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
		const clearTimer =
			this.deps.clearTimer ??
			((handle: unknown) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>));
		const previous = this.albumTimers.get(groupId);
		if (previous !== undefined) clearTimer(previous);
		this.albumTimers.set(
			groupId,
			setTimer(() => {
				this.albums.delete(groupId);
				this.albumTimers.delete(groupId);
				void this.dispatch();
			}, this.deps.albumWindowMs ?? DEFAULT_ALBUM_WINDOW_MS),
		);
	}

	/**
	 * Run a bridge control command if the message is one we handle. Returns true
	 * when the message was consumed as a command (and must not be forwarded to
	 * the agent). `/clear`, `/new`, `/reset` wipe the agent's history.
	 */
	private async tryControlCommand(message: Message): Promise<boolean> {
		const command = parseSlashCommand(messageText(message));
		if (!command) return false;
		if (CLEAR_COMMANDS.has(command.name) && this.deps.onClear) {
			await this.deps.onClear();
			return true;
		}
		if (ABORT_COMMANDS.has(command.name) && this.deps.onAbort) {
			await this.deps.onAbort();
			return true;
		}
		if (HELP_COMMANDS.has(command.name)) {
			await this.sendToChat(HELP_TEXT);
			return true;
		}
		// /start (incl. the Secretary deep link /start bizChat…) always shows the
		// privacy/compliance reminder, so the terms are surfaced on first contact.
		//
		// In the live wiring the router answers /start before the controller ever sees
		// it (it also re-posts the mode pin, which only the router can do). This stays as
		// the controller's own guarantee: whatever drives it, /start is never handed to
		// the model as a prompt, and the terms are never skipped.
		if (START_COMMANDS.has(command.name)) {
			await this.sendToChat(COMPLIANCE_NOTICE);
			return true;
		}
		return false;
	}

	/** Download image attachments for a message, swallowing per-file failures. */
	private async loadImages(message: Message): Promise<InboundImage[]> {
		if (!this.deps.loadImages) return [];
		return this.deps.loadImages(message).catch(() => []);
	}

	/** Save non-image attachments to disk, swallowing a wholesale failure. */
	private async saveAttachments(
		message: Message,
	): Promise<{ savedFiles: TurnSavedFile[]; errors: string[] }> {
		if (!this.deps.saveAttachments) return { savedFiles: [], errors: [] };
		return this.deps
			.saveAttachments(message)
			.catch(() => ({ savedFiles: [], errors: [] }));
	}

	/**
	 * Upload a file to the bound chat so the user receives it. Called by the
	 * `telegram_attach` tool; propagates errors so the tool reports them.
	 */
	async sendFile(input: {
		path?: string;
		url?: string;
		caption?: string;
	}): Promise<void> {
		if (!this.deps.uploadFile) {
			throw new Error("file upload is not available in this session");
		}
		await this.deps.uploadFile(input);
	}

	/** Build the follow-up content for a queued turn: images (if any) then text. */
	private toContent(item: QueueItem): PromptContent {
		if (!item.images || item.images.length === 0) return item.text;
		return [
			...item.images.map((img) => ({
				type: "image" as const,
				data: img.data,
				mimeType: img.mimeType,
			})),
			{ type: "text" as const, text: item.text },
		];
	}

	/** Release the next queued turn to the agent, but only while it is idle. */
	async dispatch(): Promise<void> {
		if (!this.deps.isIdle()) return;
		const next = this.queue.peek();
		if (!next) return;
		// An album still collecting its photos is not ready: releasing it now would
		// send the model the first picture and orphan the rest.
		if (this.isOpenAlbum(next.id)) return;
		const item = this.queue.dequeue();
		if (!item) return;
		this.pendingMirror = item.sourceMessageIds;
		await this.deps.sendFollowUp(this.toContent(item));
	}

	private isOpenAlbum(itemId: string): boolean {
		for (const id of this.albums.values()) if (id === itemId) return true;
		return false;
	}

	/** Arm interruption for the turn that just started. */
	onAgentStart(abortTurn: () => void): void {
		this.deps.abort.set(abortTurn);
	}

	/**
	 * Deliver one assistant message as it completes.
	 *
	 * A run is not one message: working through a task the model narrates ("Google
	 * blocked me, trying Bing"), calls tools, answers, and often adds a trailing
	 * "done, browser closed". Mirroring only the run's LAST assistant text — what
	 * agent_end used to do — delivered that trailing line and silently dropped the
	 * answer itself. So each assistant message goes out when it ends, in order, which
	 * is also the live trace of the model working.
	 */
	async deliverAssistant(text: string): Promise<void> {
		if (!text.trim()) return;
		await this.sendAnswer(text);
	}

	/**
	 * Close out the finished run and pump the next queued turn.
	 *
	 * `fallbackReply` delivers the run's last assistant text, and is a SAFETY NET
	 * only: `index.ts` passes false once anything was already mirrored message by
	 * message (see {@link deliverAssistant}), and for a run that is not the owner's
	 * (mixed: a manager moderation turn shares this session, and its text belongs to
	 * the interlocutor). The queue is pumped either way — an owner message may be
	 * waiting behind the turn that just ended.
	 */
	async onAgentEnd(
		messages: readonly unknown[],
		fallbackReply = true,
	): Promise<void> {
		this.deps.abort.clear();
		const reply = fallbackReply ? lastAssistantReply(messages) : null;
		if (reply) await this.sendAnswer(reply);
		await this.dispatch();
	}

	/** Show the Telegram "typing…" indicator on the bound chat (repeat while busy). */
	async sendTyping(): Promise<void> {
		await this.deps.outbound.chatAction(this.target, "typing").catch(() => {});
	}

	/** Send arbitrary markdown to the bound chat (used by the outbound tools). */
	async sendToChat(markdown: string): Promise<void> {
		await this.deps.outbound.sendMarkdown(this.target, markdown);
	}

	/**
	 * Mirror a prompt typed at the Pi terminal into the bound chat, clearly
	 * marked, so the Telegram history reflects everything asked — from either
	 * side. Best-effort; the real reply is still mirrored on `agent_end`.
	 */
	async mirrorTerminalInput(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		await this.deps.outbound
			.sendMarkdown(this.target, `_${TERMINAL_ORIGIN_MARKER}_\n\n${trimmed}`)
			.catch(() => {});
	}

	/**
	 * Open a streaming-draft id for the assistant message about to stream. An id
	 * already open — the thinking placeholder of this same turn — is REUSED, so the
	 * placeholder animates into the streaming text instead of being replaced by a
	 * second draft (which would read as a flicker). A closed draft gets a fresh id,
	 * distinct per message, so drafts never animate across replies.
	 */
	beginDraft(): void {
		if (this.draftId !== 0) return;
		this.draftCounter = (this.draftCounter % 1_000_000) + 1;
		this.draftId = this.draftCounter;
	}

	/**
	 * Push the turn's live trace into the draft: finished steps as plain lines, the
	 * current one animated. This is NOT the model's reasoning — the SDK exposes none;
	 * it is what the agent is DOING, filling the silence between the prompt and the
	 * first token, and it disappears with the draft. Best-effort, like
	 * {@link streamDraft}.
	 */
	async streamThinking(html: RichHtml): Promise<void> {
		if (!html.html.trim()) return;
		this.beginDraft();
		await this.flushMirror();
		await this.deps.outbound
			.draft(this.target, this.draftId, buildRichHtmlMessage(html))
			.catch(() => {});
	}

	/**
	 * Push a partial assistant reply as an ephemeral animated draft. Best-effort:
	 * a draft is a transient preview, so any failure (bot not eligible, too long)
	 * is ignored and never blocks the turn or the final send.
	 */
	async streamDraft(text: string): Promise<void> {
		if (this.draftId === 0 || !text.trim()) return;
		// The first chunk IS the bot starting to speak — the prompt it answers belongs
		// above it, not seconds earlier while the model was still silent.
		await this.flushMirror();
		await this.deps.outbound
			.draft(this.target, this.draftId, buildRichMarkdownMessage(text))
			.catch(() => {});
	}

	/** Close the current streaming draft (the real reply is sent separately). */
	endDraft(): void {
		this.draftId = 0;
	}

	/**
	 * Erase the draft in place with an empty one. A draft only expires ~30s after its
	 * last update, so a turn that ends while the placeholder is up — an abort (/esc),
	 * an error, a tool-only run — would otherwise leave "Thinking…" animating long
	 * after the agent stopped. Best-effort: if the API refuses an empty draft, the
	 * placeholder still expires on its own.
	 */
	async clearDraft(): Promise<void> {
		if (this.draftId === 0) return;
		const draftId = this.draftId;
		this.draftId = 0;
		await this.deps.outbound
			.draft(this.target, draftId, { html: "" })
			.catch(() => {});
	}

	/**
	 * Surface an agent tool invocation to the bound chat as a collapsible block
	 * (tool name + folded parameters) — it belongs with the conversation it serves, so
	 * you can watch the model work. Best-effort: a formatting/send failure must never
	 * interrupt the agent's turn.
	 *
	 * The card is posted `running` and remembered by `callId`, so
	 * {@link completeToolActivity} can finish it in place once the tool returns.
	 */
	async sendToolActivity(
		activity: ToolCallActivity,
		callId?: string,
	): Promise<void> {
		await this.flushMirror();
		const ids = await this.deps.outbound
			.sendMessages(this.target, [toolActivityMessage(activity)])
			.catch(() => [] as number[]);
		const messageId = ids[0];
		if (callId === undefined || messageId === undefined) return;
		this.toolCards.set(callId, { messageId, activity });
	}

	/**
	 * Finish the card for a call that has returned: rewrite it with a ✅ or ❌ and its
	 * output folded in, rather than posting a second message about it. Re-rendered
	 * from the REMEMBERED activity, because the end event carries no arguments — a
	 * card rebuilt without them would silently lose the command it ran.
	 *
	 * An unknown call id (cards disabled mid-turn, a card that failed to send) is a
	 * no-op, and so is a failed edit — the running card stays, which is still true.
	 */
	async completeToolActivity(
		callId: string,
		result: unknown,
		isError: boolean,
	): Promise<void> {
		const card = this.toolCards.get(callId);
		if (!card) return;
		this.toolCards.delete(callId);
		await this.deps.outbound
			.editRich(
				this.target,
				card.messageId,
				toolActivityMessage({
					...card.activity,
					status: isError ? "error" : "ok",
					result,
				}),
			)
			.catch(() => {});
	}

	/**
	 * Close out every card still waiting for a result. A call interrupted by /esc
	 * never fires its end event, so its card would otherwise keep the running state
	 * forever — claiming work that stopped. Mark them cancelled and forget them.
	 */
	async cancelOpenToolCards(): Promise<void> {
		const open = [...this.toolCards.values()];
		this.toolCards.clear();
		for (const card of open) {
			await this.deps.outbound
				.editRich(
					this.target,
					card.messageId,
					toolActivityMessage({ ...card.activity, status: "cancelled" }),
				)
				.catch(() => {});
		}
	}

	/** Pending (not yet dispatched) turn count — for footer/status. */
	pendingCount(): number {
		return this.queue.size();
	}

	/** Drop every queued turn (used by /stop). */
	clearQueue(): void {
		this.queue.clear();
	}
}
