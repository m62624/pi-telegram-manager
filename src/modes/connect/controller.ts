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
import type { Message } from "@grammyjs/types";
import type { AbortRegistry } from "../../core/abort";
import { MessageQueue, type QueueItem } from "../../core/queue";
import { buildPromptTurn } from "../../core/turns";
import type { OutboundSender, OutboundTarget } from "../../telegram/outbound";
import {
	type ToolCallActivity,
	toolActivityMessage,
} from "../../telegram/tool-activity";
import type { TelegramEvent } from "../../telegram/updates";
import {
	type InboundImage,
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
	/** Download an inbound message's image attachments as base64 (best-effort). */
	loadImages?: (message: Message) => Promise<InboundImage[]>;
	/** Handle a `/clear` (or `/new`, `/reset`) request to wipe the agent's history. */
	onClear?: () => Promise<void>;
	outbound: OutboundSender;
	abort: AbortRegistry;
}

/** Telegram bot commands the bridge handles itself instead of forwarding to the agent. */
const CLEAR_COMMANDS = new Set(["clear", "new", "reset"]);

export class ConnectController {
	private readonly queue = new MessageQueue();
	private turnCounter = 0;

	constructor(private readonly deps: ConnectControllerDeps) {}

	private get target(): OutboundTarget {
		return { chatId: this.deps.allowedUserId };
	}

	/** Handle an inbound Telegram event. Returns true when it enqueued/edited a turn. */
	async onEvent(event: TelegramEvent): Promise<boolean> {
		if (event.kind !== "message" && event.kind !== "edited_message")
			return false;
		if (event.fromId !== this.deps.allowedUserId) return false;

		// Intercept the bridge's own control commands (e.g. /clear) so they never
		// reach the agent as a prompt. Unknown commands (and /start, /help) fall
		// through and are treated as ordinary messages.
		if (await this.tryControlCommand(event.message)) return true;

		// Acknowledge receipt immediately with a "typing…" hint, before the agent
		// even starts (there is queue/dispatch latency in between).
		void this.sendTyping();

		const turn = buildPromptTurn(
			messageToTurnInput(event.message, this.deps.maxBytes),
		);

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
		return false;
	}

	/** Download image attachments for a message, swallowing per-file failures. */
	private async loadImages(message: Message): Promise<InboundImage[]> {
		if (!this.deps.loadImages) return [];
		return this.deps.loadImages(message).catch(() => []);
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
