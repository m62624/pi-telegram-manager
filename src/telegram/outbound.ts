/**
 * Send outbound content to Telegram as modern rich messages (Bot API 10.1),
 * falling back to a classic `sendMessage` when the rich API rejects a message
 * (it is very new; a bot not opted into rich, or an older API server, still
 * gets a plain-text reply). How a model's Markdown
 * becomes an `InputRichMessage` is an injected `RichRenderer` strategy — the
 * default is the Markdown fast-path (`toRichMarkdownMessages`); a
 * Markdown→Rich-HTML renderer can be swapped in for `assistant.rendering:
 * "html"` without touching this module.
 *
 * The grammY bot API is reached through the narrow {@link OutboundApi} port so
 * the transport is trivially fakeable in tests. Every send is addressed by an
 * {@link OutboundTarget}, which also carries the optional
 * `business_connection_id` used to reply on behalf of a business account
 * (mode 2) and a forum `message_thread_id`.
 */
import type { InputRichMessage } from "@grammyjs/types";
import { toRichMarkdownMessages } from "./markdown";
import { type RichContent, RichHtml } from "./rich-builder";

/** Chat actions we broadcast while preparing a reply. */
export type ChatAction =
	| "typing"
	| "upload_photo"
	| "upload_document"
	| "upload_video"
	| "record_voice";

/** Where a message goes, plus the business/thread routing keys. */
export interface OutboundTarget {
	chatId: number;
	/** Reply on behalf of this connected business account (mode 2). */
	businessConnectionId?: string;
	/** Forum topic thread. */
	messageThreadId?: number;
}

/** Routing arguments shared by every send call, with absent keys omitted. */
interface TargetArgs {
	chat_id: number;
	business_connection_id?: string;
	message_thread_id?: number;
}

/** The subset of grammY's `bot.api` outbound uses; keeps the fake small. */
export interface OutboundApi {
	sendRichMessage(
		args: TargetArgs & { rich_message: InputRichMessage },
	): Promise<{ message_id: number }>;
	/** Classic text message — the universally-supported fallback when rich send fails. */
	sendMessage(
		args: TargetArgs & { text: string },
	): Promise<{ message_id: number }>;
	sendRichMessageDraft(
		args: TargetArgs & { rich_message: InputRichMessage },
	): Promise<unknown>;
	sendChatAction(args: TargetArgs & { action: ChatAction }): Promise<unknown>;
}

/** Best-effort plain text of a rich message, for the classic fallback send. */
function richFallbackText(message: InputRichMessage): string {
	if (message.markdown?.trim()) return message.markdown;
	if (message.html?.trim()) {
		return message.html
			.replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
			.trim();
	}
	return "";
}

/** Strategy turning a model's Markdown into one or more sendable rich messages. */
export type RichRenderer = (text: string) => InputRichMessage[];

export interface OutboundSenderOptions {
	/** Defaults to the Markdown fast-path (`toRichMarkdownMessages`). */
	renderer?: RichRenderer;
}

/** Telegram rejects an empty rich message (400); skip anything with no text. */
function isEmptyRich(message: InputRichMessage): boolean {
	return !message.markdown?.trim() && !message.html?.trim();
}

function targetArgs(target: OutboundTarget): TargetArgs {
	const args: TargetArgs = { chat_id: target.chatId };
	if (target.businessConnectionId !== undefined) {
		args.business_connection_id = target.businessConnectionId;
	}
	if (target.messageThreadId !== undefined) {
		args.message_thread_id = target.messageThreadId;
	}
	return args;
}

export class OutboundSender {
	private readonly renderer: RichRenderer;

	constructor(
		private readonly api: OutboundApi,
		options: OutboundSenderOptions = {},
	) {
		this.renderer = options.renderer ?? toRichMarkdownMessages;
	}

	/** Render `markdown` and send it (possibly as several messages). Returns the sent message ids. */
	async sendMarkdown(
		target: OutboundTarget,
		markdown: string,
	): Promise<number[]> {
		return this.sendMessages(target, this.renderer(markdown));
	}

	/** Send already-built rich messages (e.g. from `RichHtmlDocument`). Returns the sent message ids. */
	async sendMessages(
		target: OutboundTarget,
		messages: readonly InputRichMessage[],
	): Promise<number[]> {
		const args = targetArgs(target);
		const ids: number[] = [];
		for (const richMessage of messages) {
			if (isEmptyRich(richMessage)) continue;
			ids.push(await this.sendOneRich(args, richMessage));
		}
		return ids;
	}

	/**
	 * Send one rich message, falling back to a classic text message when the
	 * (very new) rich API rejects it — so a reply is always delivered even if
	 * `sendRichMessage` is unavailable or misbehaves for this bot.
	 */
	private async sendOneRich(
		args: TargetArgs,
		richMessage: InputRichMessage,
	): Promise<number> {
		try {
			const sent = await this.api.sendRichMessage({
				...args,
				rich_message: richMessage,
			});
			return sent.message_id;
		} catch {
			const text = richFallbackText(richMessage);
			const sent = await this.api.sendMessage({ ...args, text });
			return sent.message_id;
		}
	}

	/** Send a short notice; plain strings are HTML-escaped, built `RichHtml` is passed through. */
	async notify(target: OutboundTarget, text: RichContent): Promise<number> {
		return this.sendOneRich(targetArgs(target), {
			html: RichHtml.of(text).html,
		});
	}

	/** Broadcast a chat action (defaults to "typing"). */
	async chatAction(
		target: OutboundTarget,
		action: ChatAction = "typing",
	): Promise<void> {
		await this.api.sendChatAction({ ...targetArgs(target), action });
	}

	/** Push an ephemeral streaming draft (finalize later with a real send). */
	async draft(
		target: OutboundTarget,
		richMessage: InputRichMessage,
	): Promise<void> {
		await this.api.sendRichMessageDraft({
			...targetArgs(target),
			rich_message: richMessage,
		});
	}
}
