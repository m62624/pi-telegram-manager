/**
 * Forum topics in the owner's private chat with the bot (Bot API 9.3).
 *
 * The owner's DM is one flat stream: personal replies, the manager's debug feed,
 * notices and mode panels all land in it. With Threaded Mode enabled for the bot
 * (the @BotFather Mini App — it is not in the classic Bot Settings keyboard) the DM
 * can be split into topics, and a bot may create them itself: `createForumTopic`
 * accepts a private chat, and every send method takes a `message_thread_id` there
 * (`getMe` reports the toggle as `has_topics_enabled`). We keep exactly two:
 *
 *  - `chat` — the conversation with the model (personal / mixed continuation);
 *  - `log`  — observability: the manager feed, tool activity, runtime notices.
 *
 * There is no API to LIST a chat's topics, so the two thread ids are persisted and
 * re-verified on start (a cheap `sendChatAction` into the thread): a topic the owner
 * deleted while the bot was off is simply recreated. Everything here is best-effort —
 * topic mode off, an old API server, or any error degrades to `undefined` thread ids,
 * which route every message to the plain DM exactly as before.
 */
import { withFileWriteLock } from "../storage/file-lock";
import type { TelegramFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";

/** The two topics we maintain in the owner's DM. */
export type TopicKind = "chat" | "log";

/** Topic icon colors, from the fixed palette Bot API allows. */
const ICON_COLOR: Record<TopicKind, number> = {
	chat: 7322096, // 0x6FB9F0 — blue
	log: 16478047, // 0xFB6F5F — red
};

/** The subset of the bot API the router needs; keeps the fake in tests small. */
export interface TopicsApi {
	getMe(): Promise<{ has_topics_enabled?: boolean }>;
	createForumTopic(args: {
		chat_id: number;
		name: string;
		icon_color?: number;
	}): Promise<{ message_thread_id: number }>;
	sendChatAction(args: {
		chat_id: number;
		message_thread_id?: number;
		action: "typing";
	}): Promise<unknown>;
}

/** Persisted thread ids, scoped to the owner they were created for. */
export interface TopicsState {
	ownerChatId: number;
	chat: number;
	log: number;
}

export interface TopicsOptions {
	/** Use topics at all. Off → the router is inert and everything stays in the DM. */
	enabled: boolean;
	chatName: string;
	logName: string;
}

export interface TopicRouterDeps {
	api: TopicsApi;
	fs: TelegramFs;
	/** Where the thread ids are persisted (`paths.topicsPath`). */
	path: string;
	ownerChatId: number;
	options: TopicsOptions;
	/** Called once with the reason when topics are unavailable (a UI hint). */
	onFallback?: (reason: string) => void;
}

/**
 * Resolves the `message_thread_id` for each kind of owner-DM message, creating the
 * topics on first use. Until {@link ensure} succeeds — and forever if it cannot —
 * every `thread()` is `undefined`, i.e. the plain DM.
 */
export class TopicRouter {
	private state: TopicsState | null = null;

	constructor(private readonly deps: TopicRouterDeps) {}

	/** The thread a message of this kind belongs to; undefined → the plain DM. */
	thread(kind: TopicKind): number | undefined {
		return this.state?.[kind];
	}

	/** Whether a thread id belongs to the log topic (owner input there is service noise). */
	isLog(threadId?: number): boolean {
		return threadId !== undefined && threadId === this.state?.log;
	}

	/** Whether topics are live (both threads resolved). */
	get active(): boolean {
		return this.state !== null;
	}

	/**
	 * Resolve both topics: reuse the persisted ids when they still exist, create what
	 * is missing, persist the result. Never throws — any failure falls back to the
	 * plain DM (and reports the reason once).
	 */
	async ensure(): Promise<boolean> {
		if (this.state !== null) return true;
		const { options } = this.deps;
		if (!options.enabled) return false;
		try {
			const me = await this.deps.api.getMe();
			if (!me.has_topics_enabled) {
				this.deps.onFallback?.(
					"Threaded Mode is off for this bot — using the plain DM. Turn it on in the @BotFather Mini App (open @BotFather, tap the menu button, pick this bot) to get separate chat/log topics.",
				);
				return false;
			}
			const stored = await this.load();
			const chat = await this.resolveTopic("chat", options.chatName, stored);
			const log = await this.resolveTopic("log", options.logName, stored);
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				chat,
				log,
			};
			await this.save(state);
			this.state = state;
			return true;
		} catch (error) {
			this.deps.onFallback?.(
				`Could not set up the chat/log topics — using the plain DM. (${String(error)})`,
			);
			return false;
		}
	}

	/**
	 * Give up on topics for this run (a thread vanished mid-session): later sends go
	 * to the plain DM, and the next `ensure` re-creates whatever is missing.
	 */
	fallBack(): void {
		this.state = null;
	}

	/** A stored topic that still accepts messages, else a freshly created one. */
	private async resolveTopic(
		kind: TopicKind,
		name: string,
		stored: TopicsState | null,
	): Promise<number> {
		const known = stored?.[kind];
		if (known !== undefined && (await this.exists(known))) return known;
		const created = await this.deps.api.createForumTopic({
			chat_id: this.deps.ownerChatId,
			name,
			icon_color: ICON_COLOR[kind],
		});
		return created.message_thread_id;
	}

	/** Probe a thread with an invisible chat action — the only cheap existence check. */
	private async exists(threadId: number): Promise<boolean> {
		try {
			await this.deps.api.sendChatAction({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
				action: "typing",
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Persisted ids, but only if they were created for THIS owner. */
	private async load(): Promise<TopicsState | null> {
		const stored = await readJsonIfExists<TopicsState>(
			this.deps.fs,
			this.deps.path,
		);
		if (!stored || stored.ownerChatId !== this.deps.ownerChatId) return null;
		return stored;
	}

	private async save(state: TopicsState): Promise<void> {
		await withFileWriteLock(this.deps.path, async () => {
			await writeJson(this.deps.fs, this.deps.path, state);
		});
	}
}
