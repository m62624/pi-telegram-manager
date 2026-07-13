/**
 * Forum topics in the owner's private chat with the bot (Bot API 9.3).
 *
 * The owner's DM is one flat stream: personal replies, the manager's feed, notices
 * and mode panels all land in it. With Threaded Mode enabled for the bot (the
 * @BotFather Mini App — it is not in the classic Bot Settings keyboard) the DM can
 * be split into topics, and a bot may create them itself: `createForumTopic` accepts
 * a private chat, and every send method takes a `message_thread_id` there (`getMe`
 * reports the toggle as `has_topics_enabled`). We keep exactly two, split by WHOSE
 * conversation it is, not by how chatty it is:
 *
 *  - `personal` — you and the model: your prompts, its replies, and the full trace
 *    of what it did for you (tool calls), in Personal mode and in mixed;
 *  - `manager`  — the secretary side: the per-turn manager feed and runtime notices,
 *    i.e. what the bot did for OTHER people.
 *
 * There is no API to LIST a chat's topics, so the two thread ids are persisted and
 * re-verified on start by renaming them to the wanted names (`editForumTopic` fails on
 * a thread that is gone): a topic the owner deleted while the bot was off is simply
 * recreated. Everything here is best-effort —
 * Threaded Mode off, an old API server, or any error degrades to `undefined` thread
 * ids, which route every message to the plain DM exactly as before.
 */
import { withFileWriteLock } from "../storage/file-lock";
import type { TelegramFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";

/** The two topics we maintain in the owner's DM. */
export type TopicKind = "personal" | "manager";

/** Topic icon colors, from the fixed palette Bot API allows. */
const ICON_COLOR: Record<TopicKind, number> = {
	personal: 7322096, // 0x6FB9F0 — blue
	manager: 16478047, // 0xFB6F5F — red
};

/** The subset of the bot API the router needs; keeps the fake in tests small. */
export interface TopicsApi {
	getMe(): Promise<{ has_topics_enabled?: boolean }>;
	createForumTopic(args: {
		chat_id: number;
		name: string;
		icon_color?: number;
	}): Promise<{ message_thread_id: number }>;
	editForumTopic(args: {
		chat_id: number;
		message_thread_id: number;
		name?: string;
	}): Promise<unknown>;
}

/** Persisted thread ids, scoped to the owner they were created for. */
export interface TopicsState {
	ownerChatId: number;
	personal: number;
	manager: number;
}

/**
 * The pre-rename layout (`chat` / `log`). Read once so an existing pair of topics is
 * ADOPTED and renamed in place rather than abandoned next to two fresh ones.
 */
interface LegacyTopicsState {
	ownerChatId: number;
	chat: number;
	log: number;
}

export interface TopicsOptions {
	/** Use topics at all. Off → the router is inert and everything stays in the DM. */
	enabled: boolean;
	personalName: string;
	managerName: string;
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

	/** Whether a thread id is the manager topic (owner input there is service noise). */
	isManager(threadId?: number): boolean {
		return threadId !== undefined && threadId === this.state?.manager;
	}

	/** Whether an error means the thread we addressed is gone (topic deleted). */
	static isMissingThread(error: unknown): boolean {
		return /message thread not found/i.test(String(error));
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
					"Threaded Mode is off for this bot — using the plain DM. Turn it on in the @BotFather Mini App (open @BotFather, tap the menu button, pick this bot) to get separate personal/manager topics.",
				);
				return false;
			}
			const stored = await this.load();
			const personal = await this.resolveTopic(
				"personal",
				options.personalName,
				stored,
			);
			const manager = await this.resolveTopic(
				"manager",
				options.managerName,
				stored,
			);
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				personal,
				manager,
			};
			await this.save(state);
			this.state = state;
			return true;
		} catch (error) {
			this.deps.onFallback?.(
				`Could not set up the personal/manager topics — using the plain DM. (${String(error)})`,
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

	/** A stored topic that still exists (adopted under the wanted name), else a new one. */
	private async resolveTopic(
		kind: TopicKind,
		name: string,
		stored: TopicsState | null,
	): Promise<number> {
		const known = stored?.[kind];
		if (known !== undefined && (await this.adopt(known, name))) return known;
		const created = await this.deps.api.createForumTopic({
			chat_id: this.deps.ownerChatId,
			name,
			icon_color: ICON_COLOR[kind],
		});
		return created.message_thread_id;
	}

	/**
	 * Claim a stored thread: rename it to the wanted name, which doubles as the
	 * existence check — `editForumTopic` FAILS on a thread that is gone, and it is the
	 * cheapest call that does. (`sendChatAction` was the old probe and is useless here:
	 * Telegram accepts it for a thread that no longer exists, so a deleted topic passed
	 * verification and every later send died with "message thread not found".) It also
	 * migrates a topic created under the old `chat`/`log` names, keeping its history.
	 */
	private async adopt(threadId: number, name: string): Promise<boolean> {
		try {
			await this.deps.api.editForumTopic({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
				name,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Persisted ids for THIS owner, in either layout (the old one is adopted). */
	private async load(): Promise<TopicsState | null> {
		const stored = await readJsonIfExists<TopicsState & LegacyTopicsState>(
			this.deps.fs,
			this.deps.path,
		);
		if (!stored || stored.ownerChatId !== this.deps.ownerChatId) return null;
		if (stored.personal !== undefined && stored.manager !== undefined) {
			return {
				ownerChatId: stored.ownerChatId,
				personal: stored.personal,
				manager: stored.manager,
			};
		}
		if (stored.chat !== undefined && stored.log !== undefined) {
			return {
				ownerChatId: stored.ownerChatId,
				personal: stored.chat,
				manager: stored.log,
			};
		}
		return null;
	}

	private async save(state: TopicsState): Promise<void> {
		await withFileWriteLock(this.deps.path, async () => {
			await writeJson(this.deps.fs, this.deps.path, state);
		});
	}
}
