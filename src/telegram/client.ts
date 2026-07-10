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
import { Bot, type PollingOptions } from "grammy";
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

	/** The grammY api surface, satisfying the `OutboundApi` / `FileApi` ports. */
	get api(): Bot["api"] {
		return this.bot.api;
	}

	/** The base URL for downloading files uploaded to this bot. */
	get fileBaseUrl(): string {
		return fileBaseUrl(this.options.token);
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
