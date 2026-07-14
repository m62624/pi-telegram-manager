/**
 * Thin lifecycle wrapper around a grammY `Bot`.
 *
 * We route every update through a single catch-all middleware into
 * `classifyUpdate`, rather than typed `bot.on(...)` handlers. That keeps
 * dispatch in one place, but it means grammY cannot auto-derive `allowed_updates`
 * — and business updates are NOT delivered by default — so we pass an explicit
 * list (`DEFAULT_ALLOWED_UPDATES`) covering every kind we classify.
 *
 * The interesting logic (building the file-download base URL, and turning an
 * update into a dispatched event) is factored into pure functions that are unit
 * tested; the grammY `Bot` wiring itself is glue.
 */
import { Bot, InputFile, type PollingOptions, type RawApi } from "grammy";
import { classifyUpdate, type TelegramEvent } from "./updates";

/** A classified event handler; may be async. Thrown errors go to `onError`. */
export type EventHandler = (event: TelegramEvent) => void | Promise<void>;

/**
 * Update kinds we ask Telegram to deliver. Must be listed explicitly because a
 * catch-all middleware gives grammY nothing to infer from — and the business_*
 * kinds are omitted from Telegram's default set.
 */
export const DEFAULT_ALLOWED_UPDATES: PollingOptions["allowed_updates"] = [
	"message",
	"edited_message",
	"business_connection",
	"business_message",
	"edited_business_message",
	"deleted_business_messages",
	"callback_query",
];

/** Build the file-download base URL for a bot token (no trailing slash). */
export function fileBaseUrl(token: string): string {
	return `https://api.telegram.org/file/bot${token}`;
}

/** Classify a raw update and hand it to the event handler. Pure but for `onEvent`. */
export async function dispatchUpdate(
	update: Parameters<typeof classifyUpdate>[0],
	onEvent: EventHandler,
): Promise<void> {
	await onEvent(classifyUpdate(update));
}

/** Fetch a URL into raw bytes using the global `fetch` (the production `FetchBytes`). */
export async function fetchBytesFromUrl(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`download failed: ${response.status} ${response.statusText}`,
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

export interface TelegramClientOptions {
	token: string;
	onEvent: EventHandler;
	/** Handle an error thrown while processing an update (defaults to rethrow-swallow). */
	onError?: (error: unknown) => void;
	/** Override the delivered update kinds. */
	allowedUpdates?: PollingOptions["allowed_updates"];
	/** Drop updates that piled up while the bot was offline (default true). */
	dropPendingUpdates?: boolean;
}

export class TelegramClient {
	readonly bot: Bot;
	private readonly options: TelegramClientOptions;

	constructor(options: TelegramClientOptions) {
		this.options = options;
		this.bot = new Bot(options.token);
		this.bot.use((ctx) => dispatchUpdate(ctx.update, options.onEvent));
		this.bot.catch((error) => {
			options.onError?.(error.error);
		});
	}

	/**
	 * The grammY *raw* api surface, satisfying the `OutboundApi` / `FileApi`
	 * ports. We deliberately expose `bot.api.raw` (single object-payload calls,
	 * e.g. `sendMessage({ chat_id, text })`) rather than the high-level `bot.api`
	 * whose methods take positional args (`sendMessage(chat_id, text)`). The raw
	 * proxy also forwards brand-new Bot API 10.1 methods (`sendRichMessage`) that
	 * are absent from the high-level surface.
	 */
	get api(): RawApi {
		return this.bot.api.raw;
	}

	/** The base URL for downloading files uploaded to this bot. */
	get fileBaseUrl(): string {
		return fileBaseUrl(this.options.token);
	}

	/**
	 * Upload a file to a chat as a document (preserving the exact bytes, unlike
	 * sendPhoto which re-encodes and caps at 10 MB). A local `path` is streamed
	 * via multipart; a `url` is handed to Telegram to fetch. Standard Bot API
	 * caps: 50 MB for uploads, 20 MB for a URL Telegram fetches.
	 *
	 * `threadId` is the topic to post into, and matters as much as the chat id: the
	 * owner's DM is split into topics, so a document sent without one lands OUTSIDE
	 * the personal topic the conversation lives in — the file appears to vanish while
	 * the model reports it sent.
	 */
	async sendDocument(input: {
		chatId: number;
		threadId?: number;
		path?: string;
		url?: string;
		caption?: string;
		/** Thread it under the message it belongs to (e.g. the tool card it completes). */
		replyToMessageId?: number;
		/**
		 * The name the file is DELIVERED under, when it should not be the one on disk.
		 * A tool writes its log wherever and however it likes (`/tmp/pi-bash-1.log`); the
		 * owner receives it on a phone, which opens a `.txt` and shrugs at a `.log`.
		 */
		filename?: string;
	}): Promise<void> {
		const document = input.path
			? new InputFile(input.path, input.filename)
			: input.url;
		if (!document) {
			throw new Error("sendDocument requires a local path or a url");
		}
		await this.bot.api.sendDocument(input.chatId, document, {
			...(input.caption ? { caption: input.caption } : {}),
			...(input.threadId !== undefined
				? { message_thread_id: input.threadId }
				: {}),
			...(input.replyToMessageId !== undefined
				? { reply_parameters: { message_id: input.replyToMessageId } }
				: {}),
		});
	}

	/** Begin long polling. Resolves only when the bot stops, so callers rarely await it. */
	async start(): Promise<void> {
		await this.bot.start({
			drop_pending_updates: this.options.dropPendingUpdates ?? true,
			allowed_updates: this.options.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES,
		});
	}

	/** Stop long polling. */
	async stop(): Promise<void> {
		await this.bot.stop();
	}
}
