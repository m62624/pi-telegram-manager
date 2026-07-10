import type { InputRichMessage } from "@grammyjs/types";
import type { ChatAction, OutboundApi } from "../../src/telegram/outbound";

interface TargetArgs {
	chat_id: number;
	business_connection_id?: string;
	message_thread_id?: number;
}

export interface SentRich extends TargetArgs {
	rich_message: InputRichMessage;
}

export interface SentAction extends TargetArgs {
	action: ChatAction;
}

/**
 * In-memory fake of the grammY api surface `OutboundSender` uses. Records every
 * call and hands out sequential message ids (starting at `firstMessageId`).
 */
export class FakeOutboundApi implements OutboundApi {
	readonly sent: SentRich[] = [];
	readonly drafts: SentRich[] = [];
	readonly actions: SentAction[] = [];
	private nextId: number;

	constructor(firstMessageId = 1000) {
		this.nextId = firstMessageId;
	}

	async sendRichMessage(args: SentRich): Promise<{ message_id: number }> {
		this.sent.push(args);
		return { message_id: this.nextId++ };
	}

	async sendRichMessageDraft(args: SentRich): Promise<unknown> {
		this.drafts.push(args);
		return true;
	}

	async sendChatAction(args: SentAction): Promise<unknown> {
		this.actions.push(args);
		return true;
	}
}
