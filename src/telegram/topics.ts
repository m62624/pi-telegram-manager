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

/** The name the outgoing `personal` is renamed to when it is kept. */
export function archiveName(personalName: string): string {
	return `${personalName} (archive)`;
}

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
	deleteForumTopic(args: {
		chat_id: number;
		message_thread_id: number;
	}): Promise<unknown>;
}

/**
 * Persisted thread ids, scoped to the owner they were created for — plus the NAMES
 * we last gave them, so a start does not rename a topic that is already called that.
 * (Renaming posts a "changed the topic name" service message every time.)
 */
export interface TopicsState {
	ownerChatId: number;
	personal: number;
	manager: number;
	names?: Record<TopicKind, string>;
	/** The previous session's `personal`, kept to read back (see {@link TopicRouter.startSession}). */
	archive?: number;
	/** Whether anything was actually said in the current `personal` this session. */
	used?: boolean;
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
	/**
	 * Whether `personal` was created by THIS `ensure` (a first run, or a topic the owner
	 * deleted). Such a topic is already brand new, so {@link startSession} leaves it
	 * alone instead of replacing it with another one — and the chat is spared a pair of
	 * "topic created" notices on every first start.
	 */
	private personalIsFresh = false;

	constructor(private readonly deps: TopicRouterDeps) {}

	/** The thread a message of this kind belongs to; undefined → the plain DM. */
	thread(kind: TopicKind): number | undefined {
		return this.state?.[kind];
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
			this.personalIsFresh = personal !== stored?.personal;
			const manager = await this.resolveTopic(
				"manager",
				options.managerName,
				stored,
			);
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				personal,
				manager,
				names: {
					personal: options.personalName,
					manager: options.managerName,
				},
				// Carried, not rebuilt: which topic is the archive, and whether the current
				// `personal` holds a conversation, is what the next session's rotation
				// decides on (see startSession). A topic we had to recreate here is new and
				// empty by definition, so it starts unused.
				...(stored?.archive !== undefined ? { archive: stored.archive } : {}),
				...(personal === stored?.personal && stored?.used
					? { used: true }
					: {}),
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

	/**
	 * Remember that the conversation actually happened in this `personal` — so the
	 * next session archives it instead of throwing it away. Called on anything the
	 * owner says and anything the bot answers; NOT on the mode pin, which is furniture.
	 */
	async markUsed(): Promise<void> {
		const state = this.state;
		if (!state || state.used) return;
		this.state = { ...state, used: true };
		await this.save(this.state);
	}

	/**
	 * Open a fresh `personal` for this session, and decide what becomes of the old one.
	 *
	 * A topic ages badly. The one we carried for weeks stopped accepting ordinary
	 * messages from the Android client — they were posted OUTSIDE it, with no
	 * `message_thread_id`, while replies (which name their target explicitly) still
	 * landed inside; Desktop never noticed. A topic created minutes earlier worked
	 * perfectly from the same phone. We cannot see when a topic goes stale, and there
	 * is no signal to check for, so we do not try: every session simply starts in a
	 * topic that is new, and none lives long enough to rot.
	 *
	 * What happens to the outgoing one is decided by whether anything was SAID in it:
	 *  - it holds a conversation → it becomes the archive (renamed), and the previous
	 *    archive is deleted, so exactly one past session is kept;
	 *  - it holds nothing but its own creation notice (a restart where you never wrote)
	 *    → it is deleted outright, taking that notice with it, and the archive is left
	 *    alone. Otherwise a couple of silent restarts would push a real conversation out
	 *    of the archive with empty topics.
	 *
	 * Best-effort: if anything here fails, the session keeps the topic it already has.
	 */
	async startSession(): Promise<void> {
		const state = this.state;
		if (!state || !this.deps.options.enabled) return;
		// Just created (first run, or the owner deleted it): it IS the fresh topic this
		// method exists to provide, and replacing it would only litter the chat with a
		// second "topic created" notice.
		if (this.personalIsFresh) return;
		const { options } = this.deps;
		let fresh: number;
		try {
			const created = await this.deps.api.createForumTopic({
				chat_id: this.deps.ownerChatId,
				name: options.personalName,
				icon_color: ICON_COLOR.personal,
			});
			fresh = created.message_thread_id;
		} catch {
			return; // no fresh topic — carry on in the one we have
		}
		const outgoing = state.personal;
		let archive = state.archive;
		if (state.used) {
			if (archive !== undefined) await this.deleteTopic(archive);
			await this.deps.api
				.editForumTopic({
					chat_id: this.deps.ownerChatId,
					message_thread_id: outgoing,
					name: archiveName(options.personalName),
				})
				.catch(() => {});
			archive = outgoing;
		} else {
			await this.deleteTopic(outgoing);
		}
		const next: TopicsState = {
			...state,
			personal: fresh,
			used: false,
			...(archive !== undefined ? { archive } : {}),
		};
		this.state = next;
		await this.save(next);
	}

	private async deleteTopic(threadId: number): Promise<void> {
		await this.deps.api
			.deleteForumTopic({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
			})
			.catch(() => {});
	}

	/**
	 * Re-check the topics we think we have, recreating whatever is gone. Called when
	 * the owner writes from somewhere we did not expect: the usual reason is that they
	 * DELETED the topics and are now typing in the plain DM (or in a thread of their
	 * own), and a bot that keeps addressing the dead thread would silently swallow
	 * every message. Returns whether topics are live afterwards.
	 */
	async revalidate(): Promise<boolean> {
		this.state = null;
		return await this.ensure();
	}

	/**
	 * Replace ONE topic that a send just proved dead ("message thread not found"), and
	 * return its new thread id.
	 *
	 * This is the repair path that does not trust the start-up probe: whatever
	 * `editForumTopic` reports for a deleted thread, a failed send is proof, so the
	 * topic is recreated on the spot and the caller retries there. Without it a topic
	 * the owner deleted mid-run degraded the whole run to the plain DM — and the
	 * manager topic never came back.
	 */
	async recreate(kind: TopicKind): Promise<number | undefined> {
		const { options } = this.deps;
		if (!options.enabled) return undefined;
		const name =
			kind === "personal" ? options.personalName : options.managerName;
		try {
			const created = await this.deps.api.createForumTopic({
				chat_id: this.deps.ownerChatId,
				name,
				icon_color: ICON_COLOR[kind],
			});
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				personal: this.state?.personal ?? created.message_thread_id,
				manager: this.state?.manager ?? created.message_thread_id,
				names: {
					personal: options.personalName,
					manager: options.managerName,
				},
			};
			state[kind] = created.message_thread_id;
			await this.save(state);
			this.state = state;
			return created.message_thread_id;
		} catch {
			// Topics are unusable now (Threaded Mode off, API error): the caller falls
			// back to the plain DM, and the next `ensure` rebuilds from scratch.
			this.state = null;
			return undefined;
		}
	}

	/** A stored topic that still exists (adopted under the wanted name), else a new one. */
	private async resolveTopic(
		kind: TopicKind,
		name: string,
		stored: TopicsState | null,
	): Promise<number> {
		const known = stored?.[kind];
		if (
			known !== undefined &&
			(await this.adopt(known, name, stored?.names?.[kind]))
		)
			return known;
		const created = await this.deps.api.createForumTopic({
			chat_id: this.deps.ownerChatId,
			name,
			icon_color: ICON_COLOR[kind],
		});
		return created.message_thread_id;
	}

	/**
	 * Claim a stored thread, and say whether it is still there.
	 *
	 * The probe is `editForumTopic` with NO fields: per the Bot API, omitted `name` /
	 * `icon_custom_emoji_id` keep the existing values, so it changes nothing — yet it
	 * FAILS on a thread that is gone, which is exactly the check we need. (The old
	 * probe was `sendChatAction`, which Telegram accepts even for a dead thread, so a
	 * deleted topic passed verification and every later send died with "message thread
	 * not found".)
	 *
	 * The rename is a SEPARATE call, made only when the name actually differs from the
	 * one we last set — renaming posts a "changed the topic name" service message, so
	 * doing it on every start littered the chat with them. `currentName` is undefined
	 * for a topic created before we stored names (or under the old chat/log layout),
	 * which is precisely when a one-off rename is wanted.
	 */
	private async adopt(
		threadId: number,
		name: string,
		currentName?: string,
	): Promise<boolean> {
		try {
			await this.deps.api.editForumTopic({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
			});
		} catch {
			return false;
		}
		if (currentName !== name) {
			await this.deps.api
				.editForumTopic({
					chat_id: this.deps.ownerChatId,
					message_thread_id: threadId,
					name,
				})
				.catch(() => {});
		}
		return true;
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
				names: stored.names,
				...(stored.archive !== undefined ? { archive: stored.archive } : {}),
				...(stored.used !== undefined ? { used: stored.used } : {}),
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
