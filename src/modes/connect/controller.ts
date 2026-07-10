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
import type { AbortRegistry } from "../../core/abort";
import { TERMINAL_ORIGIN_MARKER } from "../../core/prompt-origin";
import { MessageQueue, type QueueItem } from "../../core/queue";
import { buildPromptTurn, type TurnSavedFile } from "../../core/turns";
import { buildRichMarkdownMessage } from "../../telegram/markdown";
import type { OutboundSender, OutboundTarget } from "../../telegram/outbound";
import {
	type ToolCallActivity,
	toolActivityMessage,
} from "../../telegram/tool-activity";
import type { TelegramEvent } from "../../telegram/updates";
import {
	formatPiCommandList,
	type InboundImage,
	lastAssistantReply,
	messageText,
	messageToTurnInput,
	type PiCommandInfo,
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
	/** Enumerate the registered Pi slash commands for the `/commands` discovery list. */
	listCommands?: () => PiCommandInfo[];
	/** Record/refresh the sender's profile in the contact store (best-effort). */
	onContact?: (user: User) => Promise<void>;
	outbound: OutboundSender;
	abort: AbortRegistry;
}

// Telegram bot commands the bridge handles itself instead of forwarding to the
// agent. Everything else (including /start) falls through as an ordinary prompt.
const CLEAR_COMMANDS = new Set(["clear", "new", "reset"]);
const ABORT_COMMANDS = new Set(["esc", "cancel"]);
const HELP_COMMANDS = new Set(["help"]);
const LIST_COMMANDS = new Set(["commands", "menu"]);

/** Static help shown for `/help`, mirroring the Telegram command menu. */
const HELP_TEXT = [
	"*Pi terminal bridge*",
	"/esc — cancel the current turn",
	"/clear — clear the conversation history",
	"/help — show this help",
].join("\n");

export class ConnectController {
	private readonly queue = new MessageQueue();
	private turnCounter = 0;
	/** Non-zero id of the current streaming draft; 0 when none is active. */
	private draftId = 0;
	/** Monotonic source of draft ids, so each message animates as its own draft. */
	private draftCounter = 0;

	constructor(private readonly deps: ConnectControllerDeps) {}

	private get target(): OutboundTarget {
		return { chatId: this.deps.allowedUserId };
	}

	/** Handle an inbound Telegram event. Returns true when it enqueued/edited a turn. */
	async onEvent(event: TelegramEvent): Promise<boolean> {
		if (event.kind !== "message" && event.kind !== "edited_message")
			return false;
		if (event.fromId !== this.deps.allowedUserId) return false;

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

		// Save non-image files to disk (best-effort) so the model gets real paths;
		// images ride along inline via loadImages.
		const intake = await this.saveAttachments(event.message);
		const turn = buildPromptTurn({
			...messageToTurnInput(event.message, this.deps.maxBytes),
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
		this.queue.enqueue({
			id: `turn-${this.turnCounter++}`,
			lane: "default",
			text: turn,
			images: images.length > 0 ? images : undefined,
			sourceMessageIds: [event.message.message_id],
		});
		await this.dispatch();
		return true;
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
		if (LIST_COMMANDS.has(command.name) && this.deps.listCommands) {
			await this.sendToChat(formatPiCommandList(this.deps.listCommands()));
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
		const item = this.queue.dequeue();
		if (!item) return;
		await this.deps.sendFollowUp(this.toContent(item));
	}

	/** Arm interruption for the turn that just started. */
	onAgentStart(abortTurn: () => void): void {
		this.deps.abort.set(abortTurn);
	}

	/** Mirror the finished reply back to Telegram, then pump the next queued turn. */
	async onAgentEnd(messages: readonly unknown[]): Promise<void> {
		this.deps.abort.clear();
		const reply = lastAssistantReply(messages);
		if (reply) await this.deps.outbound.sendMarkdown(this.target, reply);
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

	/** Open a fresh streaming-draft id for the assistant message about to stream. */
	beginDraft(): void {
		// Non-zero and distinct per message so drafts never animate across replies.
		this.draftCounter = (this.draftCounter % 1_000_000) + 1;
		this.draftId = this.draftCounter;
	}

	/**
	 * Push a partial assistant reply as an ephemeral animated draft. Best-effort:
	 * a draft is a transient preview, so any failure (bot not eligible, too long)
	 * is ignored and never blocks the turn or the final send.
	 */
	async streamDraft(text: string): Promise<void> {
		if (this.draftId === 0 || !text.trim()) return;
		await this.deps.outbound
			.draft(this.target, this.draftId, buildRichMarkdownMessage(text))
			.catch(() => {});
	}

	/** Close the current streaming draft (the real reply is sent separately). */
	endDraft(): void {
		this.draftId = 0;
	}

	/**
	 * Surface an agent tool invocation to the bound chat as a collapsible block
	 * (tool name + folded parameters). Best-effort: a formatting/send failure
	 * must never interrupt the agent's turn.
	 */
	async sendToolActivity(activity: ToolCallActivity): Promise<void> {
		await this.deps.outbound
			.sendMessages(this.target, [toolActivityMessage(activity)])
			.catch(() => {});
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
