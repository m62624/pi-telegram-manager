/**
 * Send outbound content to Telegram as modern rich messages (Bot API 10.1).
 *
 * There is no legacy `sendMessage(parse_mode)` path: everything goes through
 * `sendRichMessage`. How a model's Markdown becomes an `InputRichMessage` is an
 * injected `RichRenderer` strategy — the default is the Markdown fast-path
 * (`toRichMarkdownMessages`); a Markdown→Rich-HTML renderer can be swapped in
 * for `assistant.rendering: "html"` without touching this module.
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
	sendRichMessageDraft(
		args: TargetArgs & { rich_message: InputRichMessage },
	): Promise<unknown>;
	sendChatAction(args: TargetArgs & { action: ChatAction }): Promise<unknown>;
}

/** Strategy turning a model's Markdown into one or more sendable rich messages. */
export type RichRenderer = (text: string) => InputRichMessage[];

export interface OutboundSenderOptions {
	/** Defaults to the Markdown fast-path (`toRichMarkdownMessages`). */
	renderer?: RichRenderer;
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
			const sent = await this.api.sendRichMessage({
				...args,
				rich_message: richMessage,
			});
			ids.push(sent.message_id);
		}
		return ids;
	}

	/** Send a short notice; plain strings are HTML-escaped, built `RichHtml` is passed through. */
	async notify(target: OutboundTarget, text: RichContent): Promise<number> {
		const sent = await this.api.sendRichMessage({
			...targetArgs(target),
			rich_message: { html: RichHtml.of(text).html },
		});
		return sent.message_id;
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
