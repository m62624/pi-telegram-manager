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
import type { AbortRegistry } from "../../core/abort";
import { MessageQueue } from "../../core/queue";
import { buildPromptTurn } from "../../core/turns";
import type { OutboundSender, OutboundTarget } from "../../telegram/outbound";
import type { TelegramEvent } from "../../telegram/updates";
import { assistantReplyText, messageToTurnInput } from "./messages";

export interface ConnectControllerDeps {
	/** Only messages from this Telegram user are accepted (their private chat id). */
	allowedUserId: number;
	/** Attachment size cap for describing inbound media. */
	maxBytes: number;
	/** Whether the agent is currently idle (not streaming). */
	isIdle: () => boolean;
	/** Deliver a prompt turn to the agent as a follow-up (no interruption). */
	sendFollowUp: (text: string) => Promise<void>;
	outbound: OutboundSender;
	abort: AbortRegistry;
}

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

		const turn = buildPromptTurn(
			messageToTurnInput(event.message, this.deps.maxBytes),
		);

		if (
			event.kind === "edited_message" &&
			this.queue.editBySource(event.message.message_id, turn)
		) {
			return true; // still queued — rewrote it in place, no new dispatch
		}

		this.queue.enqueue({
			id: `turn-${this.turnCounter++}`,
			lane: "default",
			text: turn,
			sourceMessageIds: [event.message.message_id],
		});
		await this.dispatch();
		return true;
	}

	/** Release the next queued turn to the agent, but only while it is idle. */
	async dispatch(): Promise<void> {
		if (!this.deps.isIdle()) return;
		const item = this.queue.dequeue();
		if (!item) return;
		await this.deps.sendFollowUp(item.text);
	}

	/** Arm interruption for the turn that just started. */
	onAgentStart(abortTurn: () => void): void {
		this.deps.abort.set(abortTurn);
	}

	/** Mirror the finished reply back to Telegram, then pump the next queued turn. */
	async onAgentEnd(messages: readonly unknown[]): Promise<void> {
		this.deps.abort.clear();
		const last = messages.at(-1);
		const reply = last ? assistantReplyText(last as { role?: string }) : null;
		if (reply) await this.deps.outbound.sendMarkdown(this.target, reply);
		await this.dispatch();
	}

	/** Send arbitrary markdown to the bound chat (used by the outbound tools). */
	async sendToChat(markdown: string): Promise<void> {
		await this.deps.outbound.sendMarkdown(this.target, markdown);
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
