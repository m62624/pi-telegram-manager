/**
 * Forum topics in the owner's private chat with the bot (Bot API 9.3).
 *
 * The owner's DM is one flat stream: personal replies, the manager's feed, notices
 * and mode panels all land in it. With Threaded Mode enabled for the bot (the
 * @BotFather Mini App — it is not in the classic Bot Settings keyboard) the DM can
 * be split into topics, and a bot may create them itself: `createForumTopic` accepts
 * a private chat, and every send method takes a `message_thread_id` there (`getMe`
 * reports the toggle as `has_topics_enabled`). We keep three, split by WHOSE
 * conversation it is and — for the secretary side — by whether the bot actually SPOKE:
 *
 *  - `personal` — you and the model: your prompts, its replies, and the full trace
 *    of what it did for you (tool calls), in Personal mode and in mixed;
 *  - `manager`  — the secretary's work product: only the replies the bot delivered to
 *    OTHER people. Kept clean so it reads as a log of what was actually said;
 *  - `log`      — the secretary's diagnostics: deliberate silences, held drafts, plain-
 *    text corrections, and the runtime notices. What you open only when something looks
 *    off. This is where the noise that used to bury the `manager` topic now lives.
 *
 * There is no API to LIST a chat's topics, so the thread ids are persisted and reused. A
 * gone thread cannot be probed for free — `editForumTopic` with no fields returns `ok` for
 * ANY id (see {@link adopt}) — so a topic the owner deleted is caught either by a validating
 * rename (when its name changed) or reactively, when the first send fails "message thread not
 * found" and {@link recreate} rebuilds it. That same missing-LIST is why an id we ever minted
 * must never be dropped: a `personal` we rotate away, or a stored topic we can no longer
 * adopt, is kept (in `stale`) and its deletion retried every start until Telegram confirms it
 * gone — an id we forget is an orphan we can never find to clean up. Everything here is
 * best-effort — Threaded Mode off, an old API server, or any error degrades to `undefined`
 * thread ids, which route every message to the plain DM exactly as before.
 */
import type { DmStateStore } from "../storage/dm-state";

/** The three topics we maintain in the owner's DM. */
export type TopicKind = "personal" | "manager" | "log";

/** The name the outgoing `personal` is renamed to when it is kept. */
export function archiveName(personalName: string): string {
	return `${personalName} (archive)`;
}

/**
 * The name for a topic Telegram refuses to delete (`TOPIC_ID_INVALID`) and that holds
 * nothing worth keeping. It cannot be removed, so it is at least named honestly instead
 * of standing next to the live topic under the same name.
 */
export function deadName(personalName: string): string {
	return `${personalName} (closed)`;
}

/**
 * Where an owner message was written — the fact everything about it depends on.
 *
 *  - `personal` — the conversation with the model: answered, and left alone;
 *  - `ours`     — a topic this bot made and does not talk to you in: the `manager` feed,
 *    the `archive`, a topic Telegram refused to delete. The bot's own writing there is
 *    output, but a message YOU typed there is still a message to the bot, and it does not
 *    belong in a service feed — so it is MOVED into `personal`, exactly like the "All"
 *    view. (Only owner messages ever reach this function; a private chat delivers no
 *    updates for what the bot itself posted, so its own cards are never touched.)
 *  - `outside`  — the "All" view, where Telegram itself labels the input box "message
 *    outside a topic". Nothing lives there, so the message is MOVED into `personal`
 *    (copied, then deleted) and the conversation stays in one place;
 *  - `topic`    — a topic the owner made themselves. It is copied into `personal` and
 *    the original is LEFT THERE: that topic is theirs, and a bot that empties it to tidy
 *    its own conversation is a bot that deletes your things.
 *
 * A message written in a topic always names it (`message_thread_id`, plus
 * `is_topic_message`) — measured on Desktop and on Android, into an old topic and a new
 * one. So the absence of a thread is not missing information: it is the answer.
 * `isTopicMessage` is the safety catch — should Telegram ever mark a message as a topic
 * message without saying which topic, it is treated as `personal` rather than moved out
 * of a topic we cannot name.
 */
export type OwnerMessagePlace = "personal" | "ours" | "outside" | "topic";

export function placeOfOwnerMessage(input: {
	thread: number | undefined;
	isTopicMessage?: boolean;
	personal: number | undefined;
	/** Every thread this bot created (see {@link TopicRouter.ownThreads}). */
	ours: readonly number[];
}): OwnerMessagePlace {
	const { thread, personal, ours } = input;
	if (thread !== undefined) {
		if (thread === personal) return "personal";
		return ours.includes(thread) ? "ours" : "topic";
	}
	return input.isTopicMessage === true ? "personal" : "outside";
}

/** Topic icon colors, from the fixed palette Bot API allows. */
const ICON_COLOR: Record<TopicKind, number> = {
	personal: 7322096, // 0x6FB9F0 — blue
	manager: 16478047, // 0xFB6F5F — red
	log: 16766590, // 0xFFD67E — yellow
};

/**
 * The icon each topic wears, so the chips are told apart at a glance: the
 * conversation, the replies the secretary delivered, its diagnostics log, and the
 * conversation before this one.
 *
 * These are plain emoji, resolved at run time to the custom-emoji ids Telegram allows
 * as topic icons (`getForumTopicIconStickers` — an arbitrary emoji is refused). If the
 * lookup fails, the topics simply keep their colours, which is what they had before.
 *
 * The archive gets an icon rather than a colour on purpose: a colour can only be set
 * when a topic is CREATED, and the archive is not created — it is the `personal` topic
 * renamed. `editForumTopic` can change the name and the custom emoji, never the colour.
 */
const ICON_EMOJI = {
	personal: "💻",
	manager: "📣",
	// A memo, not a clipboard: only the emoji Telegram itself offers as a topic icon
	// (getForumTopicIconStickers) render — 📋 is NOT in that set and silently degraded to
	// a bare colour, so the diagnostics topic wore no icon. 📝 is in the set.
	log: "📝",
	archive: "📁",
} as const;

/** A sticker as `getForumTopicIconStickers` returns it (only what we read). */
export interface TopicIconSticker {
	emoji?: string;
	custom_emoji_id?: string;
}

/** The subset of the bot API the router needs; keeps the fake in tests small. */
export interface TopicsApi {
	getMe(): Promise<{ has_topics_enabled?: boolean }>;
	createForumTopic(args: {
		chat_id: number;
		name: string;
		icon_color?: number;
		icon_custom_emoji_id?: string;
	}): Promise<{ message_thread_id: number }>;
	editForumTopic(args: {
		chat_id: number;
		message_thread_id: number;
		name?: string;
		icon_custom_emoji_id?: string;
	}): Promise<unknown>;
	deleteForumTopic(args: {
		chat_id: number;
		message_thread_id: number;
	}): Promise<unknown>;
	getForumTopicIconStickers(): Promise<TopicIconSticker[]>;
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
	/**
	 * The diagnostics topic. Optional in the STORED shape only: an install that
	 * predates this topic has `{personal, manager}` and no `log`, and must still load
	 * so {@link TopicRouter.ensure} can create the missing one rather than throwing the
	 * whole pair away. Once resolved it is always present.
	 */
	log?: number;
	names?: Partial<Record<TopicKind, string>>;
	/** The previous session's `personal`, kept to read back (see {@link TopicRouter.startSession}). */
	archive?: number;
	/** Whether anything was actually said in the current `personal` this session. */
	used?: boolean;
	/** Topics Telegram refused to delete; retried on every later session. */
	stale?: number[];
	/**
	 * The Pi session id the current `personal` topic belongs to. The topic is a mirror
	 * of ONE session's memory, so it is rotated exactly when this id changes (the owner
	 * resumed a different session on the computer) — not on every mode switch. See
	 * {@link TopicRouter.startSession}. Undefined for topics minted before this field
	 * existed, or when the session id was unknown at mint time.
	 */
	personalSessionId?: string;
	/**
	 * When the current `personal` topic was created (epoch ms). Read by the age net in
	 * {@link TopicRouter.startSession} to refresh a topic that outlived Telegram's own
	 * id staleness while its session stayed the same. Undefined for pre-existing topics.
	 */
	personalCreatedAt?: number;
}

/**
 * The pre-rename layout (`chat` / `log`). Read once so an existing pair of topics is
 * ADOPTED and renamed in place rather than abandoned next to two fresh ones.
 */
export interface TopicsOptions {
	/** Use topics at all. Off → the router is inert and everything stays in the DM. */
	enabled: boolean;
	personalName: string;
	managerName: string;
	logName: string;
}

export interface TopicRouterDeps {
	api: TopicsApi;
	/** Where the thread ids are persisted — the owner's DM state (`paths.dmStatePath`). */
	store: DmStateStore<TopicsState>;
	ownerChatId: number;
	options: TopicsOptions;
	/** Called once with the reason when topics are unavailable (a UI hint). */
	onFallback?: (reason: string) => void;
	/** The clock, injectable so the age net (see {@link startSession}) is testable. */
	now?: () => number;
}

/**
 * How old the `personal` topic may get before a start refreshes it even when the
 * session did not change. Telegram's own topic ids go stale after a few days; a single
 * Pi session kept alive that long would otherwise sit in an ageing topic forever. Two
 * days leaves a wide margin under that.
 */
export const PERSONAL_TOPIC_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

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
	/** emoji → the custom-emoji id Telegram accepts for it; loaded once, best-effort. */
	private icons: Map<string, string> | null = null;

	constructor(private readonly deps: TopicRouterDeps) {}

	/** The current time, from the injected clock in tests or the wall clock otherwise. */
	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

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
	 * Every thread this bot made: the two topics, the archive it renamed, and the ones
	 * Telegram refused to delete. Together with `personal` they say which topics are the
	 * bot's own furniture — and a message the owner typed in any of them is a message to
	 * the bot that ended up in the wrong room, not a note in a room of their own.
	 */
	get ownThreads(): readonly number[] {
		const state = this.state;
		if (!state) return [];
		return [
			state.personal,
			state.manager,
			...(state.log !== undefined ? [state.log] : []),
			...(state.archive !== undefined ? [state.archive] : []),
			...(state.stale ?? []),
		];
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
			const personalR = await this.resolveTopic(
				"personal",
				options.personalName,
				stored,
			);
			const personal = personalR.id;
			this.personalIsFresh = personal !== stored?.personal;
			const managerR = await this.resolveTopic(
				"manager",
				options.managerName,
				stored,
			);
			const manager = managerR.id;
			// The diagnostics topic. Missing from an install that predates it (see
			// TopicsState.log) — resolveTopic then simply creates it, which is exactly how
			// "everyone picks up the new log topic" happens: on the next start.
			const logR = await this.resolveTopic("log", options.logName, stored);
			const log = logR.id;
			// Ids we minted and just replaced (a stored topic we could not adopt), plus any we
			// still owe a delete from before. NEVER a live id — the same number can come back
			// as a freshly created topic, and a topic in use must never be queued for its own
			// deletion. This is the orphan fix: an id dropped here can never be found again
			// (Telegram cannot LIST topics), so it is kept until a delete confirms it gone.
			const live = new Set<number>([
				personal,
				manager,
				log,
				...(stored?.archive !== undefined ? [stored.archive] : []),
			]);
			const pending = [
				...(stored?.stale ?? []),
				personalR.abandoned,
				managerR.abandoned,
				logR.abandoned,
			].filter((id): id is number => id !== undefined && !live.has(id));
			const stale = await this.sweepStale([...new Set(pending)]);
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				personal,
				manager,
				log,
				names: {
					personal: options.personalName,
					manager: options.managerName,
					log: options.logName,
				},
				// Carried, not rebuilt: which topic is the archive, and whether the current
				// `personal` holds a conversation, is what the next session's rotation
				// decides on (see startSession). A topic we had to recreate here is new and
				// empty by definition, so it starts unused.
				...(stored?.archive !== undefined ? { archive: stored.archive } : {}),
				...(personal === stored?.personal && stored?.used
					? { used: true }
					: {}),
				// The session a carried-over `personal` belongs to travels with it, and so
				// does its age: only a topic we actually re-adopted keeps them, so both the
				// session gate and the age net still fire for a topic we had to recreate here.
				...(personal === stored?.personal &&
				stored?.personalSessionId !== undefined
					? { personalSessionId: stored.personalSessionId }
					: {}),
				...(personal === stored?.personal &&
				stored?.personalCreatedAt !== undefined
					? { personalCreatedAt: stored.personalCreatedAt }
					: {}),
				...(stale.length > 0 ? { stale } : {}),
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
	 * A topic can go bad. A three-day-old one — which had survived a rename and a chat
	 * the owner deleted — stopped accepting ordinary messages from the Android client:
	 * they were posted OUTSIDE it, with no `message_thread_id`, while replies (which
	 * name their target explicitly) still landed inside, and Desktop never noticed. A
	 * topic created minutes earlier took the same message from the same phone. What
	 * exactly ruins a topic we do not know, and there is no signal to check for, so we
	 * do not try to detect it: every session simply starts in a topic that is new, and
	 * none lives long enough to find out.
	 *
	 * What happens to the outgoing one is decided by whether anything was SAID in it:
	 *  - it holds a conversation → it becomes the archive (renamed), and the previous
	 *    archive is deleted, so exactly one past session is kept;
	 *  - it holds nothing but its own creation notice (a restart where you never wrote)
	 *    → it is deleted outright, taking that notice with it, and the archive is left
	 *    alone. Otherwise a couple of silent restarts would push a real conversation out
	 *    of the archive with empty topics.
	 *
	 * Deleting is NOT guaranteed. Telegram refuses some topics with
	 * `400: TOPIC_ID_INVALID` — a topic that survived the owner clearing the chat, for
	 * one — while `editForumTopic` still answers `ok` for the very same id, so nothing
	 * warns us in advance. Swallowing that refusal is what turned this feature into a
	 * chip factory: every switch added a topic and removed none. So a refusal is now a
	 * fact we keep: the topic is renamed out of the way (it must not sit there as a
	 * second `personal`) and retried on later sessions.
	 *
	 * Best-effort: if a fresh topic cannot be created, the session keeps the one it has
	 * and nothing else is touched.
	 */
	async startSession(
		sessionId?: string,
		opts?: { force?: boolean },
	): Promise<{ ageRefreshed: boolean; topicFresh: boolean }> {
		// `topicFresh` says the personal topic is blank right now — brand new or just
		// rotated — so the caller may want to mirror the session's history into it. `kept`
		// is the opposite: the existing topic already shows that history, leave it be.
		const kept = { ageRefreshed: false, topicFresh: false };
		const freshIdle = { ageRefreshed: false, topicFresh: true };
		const state = this.state;
		if (!state || !this.deps.options.enabled) return kept;
		const force = opts?.force ?? false;
		// Just created (first run, or the owner deleted it): it IS the fresh topic this
		// method exists to provide, and replacing it would only litter the chat with a
		// second "topic created" notice. Stamp the session it belongs to first, so a
		// later start in the SAME session recognises it and does not rotate.
		if (this.personalIsFresh) {
			await this.stampPersonalSession(state, sessionId);
			return freshIdle;
		}
		const sameSession =
			sessionId !== undefined && state.personalSessionId === sessionId;
		// The topic has outlived Telegram's own id staleness while its session stayed the
		// same: refresh it even though nothing about the memory changed. This is the only
		// rotation the owner is told about — the context genuinely continues.
		const aged =
			state.personalCreatedAt !== undefined &&
			this.now() - state.personalCreatedAt > PERSONAL_TOPIC_MAX_AGE_MS;
		// The topic already mirrors THIS session, the owner did not force a reset, and it
		// is not stale: its visible history is the model's memory, so keep it. This is what
		// stops a mode switch (same session, no context change) from minting a topic every
		// time. A missing sessionId means "session unknown" — treat as a change and rotate.
		if (!force && sameSession && !aged) {
			return kept;
		}
		const ageRefreshed = !force && sameSession && aged;
		const { options } = this.deps;
		let fresh: number;
		try {
			const created = await this.create("personal", options.personalName);
			fresh = created.message_thread_id;
		} catch {
			return kept; // no fresh topic — carry on in the one we have
		}
		// Topics Telegram would not delete before: try again, it may allow it now.
		const stale: number[] = [];
		for (const id of state.stale ?? []) {
			if (!(await this.deleteTopic(id))) stale.push(id);
		}
		const outgoing = state.personal;
		let archive = state.archive;
		if (state.used) {
			if (archive !== undefined && !(await this.deleteTopic(archive))) {
				stale.push(archive);
			}
			await this.rename(outgoing, archiveName(options.personalName), "archive");
			archive = outgoing;
		} else if (!(await this.deleteTopic(outgoing))) {
			// Nothing was said in it, and it will not go away. It must not stay next to
			// the new topic under the same name, and it must not evict the archive — it
			// holds nothing worth keeping. Name it for what it is and keep trying later.
			await this.rename(outgoing, deadName(options.personalName), "archive");
			stale.push(outgoing);
		}
		// Rebuilt rather than spread over the old state: `archive` and `stale` are
		// decided fresh here, and a stale id that Telegram finally removed must not be
		// inherited from the state we started with — it would be retried forever.
		const next: TopicsState = {
			ownerChatId: state.ownerChatId,
			personal: fresh,
			manager: state.manager,
			log: state.log,
			names: state.names,
			used: false,
			...(archive !== undefined ? { archive } : {}),
			...(stale.length > 0 ? { stale } : {}),
			...(sessionId !== undefined ? { personalSessionId: sessionId } : {}),
			personalCreatedAt: this.now(),
		};
		this.state = next;
		await this.save(next);
		return { ageRefreshed, topicFresh: true };
	}

	/**
	 * Record which session the current (already-fresh) `personal` belongs to — and when
	 * it was created, so the age net can measure it — without rotating it. A no-op when
	 * the id is unknown or already recorded, so a fresh topic is not re-saved for nothing.
	 */
	private async stampPersonalSession(
		state: TopicsState,
		sessionId?: string,
	): Promise<void> {
		if (sessionId === undefined) return;
		if (
			state.personalSessionId === sessionId &&
			state.personalCreatedAt !== undefined
		) {
			return;
		}
		const next: TopicsState = {
			...state,
			personalSessionId: sessionId,
			personalCreatedAt: this.now(),
		};
		this.state = next;
		await this.save(next);
	}

	/** Rename a topic and re-badge it. Best-effort — a name is not worth a failed start. */
	private async rename(
		threadId: number,
		name: string,
		icon: keyof typeof ICON_EMOJI,
	): Promise<void> {
		const emoji = await this.iconFor(icon);
		await this.deps.api
			.editForumTopic({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
				name,
				...(emoji ? { icon_custom_emoji_id: emoji } : {}),
			})
			.catch(() => {});
	}

	/**
	 * The custom-emoji id for one of our icons, or undefined when Telegram does not
	 * offer it (or the list could not be read — then the topic keeps its colour).
	 *
	 * Only the emoji Telegram itself hands out may be a topic icon; an arbitrary one is
	 * refused, and a refused create would cost us the topic. So the list is fetched once
	 * and matched by the emoji character, with the variation selector Telegram sometimes
	 * appends (U+FE0F) stripped on both sides.
	 */
	private async iconFor(
		kind: keyof typeof ICON_EMOJI,
	): Promise<string | undefined> {
		if (this.icons === null) {
			this.icons = new Map();
			const stickers = await this.deps.api
				.getForumTopicIconStickers()
				.catch(() => [] as TopicIconSticker[]);
			for (const sticker of stickers) {
				const emoji = sticker.emoji?.replace(/️/g, "");
				if (emoji && sticker.custom_emoji_id) {
					this.icons.set(emoji, sticker.custom_emoji_id);
				}
			}
		}
		return this.icons.get(ICON_EMOJI[kind].replace(/️/g, ""));
	}

	/** Create a topic wearing its icon (falling back to its colour). */
	private async create(
		kind: TopicKind,
		name: string,
	): Promise<{ message_thread_id: number }> {
		const icon = await this.iconFor(kind);
		return await this.deps.api.createForumTopic({
			chat_id: this.deps.ownerChatId,
			name,
			...(icon
				? { icon_custom_emoji_id: icon }
				: { icon_color: ICON_COLOR[kind] }),
		});
	}

	/**
	 * Delete a topic, and say whether it is now gone. "Gone" includes a topic that was
	 * ALREADY gone: a `message thread not found` is a deletion that already happened, so it
	 * reports success and stops being retried (a topic the owner deleted themselves would
	 * otherwise be chased forever). Only a real refusal — `TOPIC_ID_INVALID`, a topic that
	 * survived the owner clearing the chat — returns false and is kept pending.
	 */
	private async deleteTopic(threadId: number): Promise<boolean> {
		return await this.deps.api
			.deleteForumTopic({
				chat_id: this.deps.ownerChatId,
				message_thread_id: threadId,
			})
			.then(() => true)
			.catch((error) => TopicRouter.isMissingThread(error));
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
			kind === "personal"
				? options.personalName
				: kind === "manager"
					? options.managerName
					: options.logName;
		try {
			const created = await this.create(kind, name);
			const state: TopicsState = {
				ownerChatId: this.deps.ownerChatId,
				personal: this.state?.personal ?? created.message_thread_id,
				manager: this.state?.manager ?? created.message_thread_id,
				log: this.state?.log ?? created.message_thread_id,
				names: {
					personal: options.personalName,
					manager: options.managerName,
					log: options.logName,
				},
				// Recreating the personal topic mints a brand-new one whose session is
				// unknown here, so its id and age are dropped (the next start rotates it).
				// Recreating any OTHER topic leaves `personal` untouched, so both are kept.
				...(kind !== "personal" && this.state?.personalSessionId !== undefined
					? { personalSessionId: this.state.personalSessionId }
					: {}),
				...(kind !== "personal" && this.state?.personalCreatedAt !== undefined
					? { personalCreatedAt: this.state.personalCreatedAt }
					: {}),
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

	/**
	 * A stored topic that still exists (adopted under the wanted name), else a new one —
	 * and, when a stored id could not be adopted, that id back as `abandoned` so the caller
	 * can queue it for deletion instead of losing it (see {@link ensure}). An id we forget
	 * is an orphan we can never find again: Telegram offers no way to LIST a chat's topics.
	 */
	private async resolveTopic(
		kind: TopicKind,
		name: string,
		stored: TopicsState | null,
	): Promise<{ id: number; abandoned?: number }> {
		const known = stored?.[kind];
		if (
			known !== undefined &&
			(await this.adopt(known, name, stored?.names?.[kind]))
		)
			return { id: known };
		const created = await this.create(kind, name);
		return {
			id: created.message_thread_id,
			...(known !== undefined ? { abandoned: known } : {}),
		};
	}

	/**
	 * Retry the deletions we still owe — every id we minted and could not remove yet — and
	 * return the ones Telegram STILL refuses (`TOPIC_ID_INVALID`), to try again next start.
	 * An id already gone counts as done and drops off (see {@link deleteTopic}), so a topic
	 * the owner deleted themselves is not chased forever.
	 */
	private async sweepStale(ids: readonly number[]): Promise<number[]> {
		const survivors: number[] = [];
		for (const id of ids) {
			if (!(await this.deleteTopic(id))) survivors.push(id);
		}
		return survivors;
	}

	/**
	 * Claim a stored thread, and say whether it is still there.
	 *
	 * The old probe was `editForumTopic` with NO fields, believed to fail on a gone thread.
	 * Measured live on a private-chat forum (Bot API 9.x), it does NOT: with no fields it
	 * returns `ok` for ANY id — a deleted topic, even an id that was never a topic. So it
	 * validated nothing; a topic the owner deleted was "adopted" and then addressed until
	 * every send failed, which is one engine of the orphan pile. `sendChatAction`, the probe
	 * before that, was just as blind.
	 *
	 * A `name` makes the call actually validate — a gone thread throws `TOPIC_ID_INVALID`.
	 * But renaming to a name the topic does not already have posts a "changed the topic name"
	 * service message, and setting the SAME name posts one too (measured), so we cannot probe
	 * for free. Hence: only when the wanted name differs from the one we last set do we send
	 * it — that one call both validates and renames. When the name already matches we trust
	 * the id and let the reactive path catch a dead one: a real send to a gone thread fails
	 * "message thread not found" and {@link recreate} rebuilds it on the spot. `currentName`
	 * is undefined for a topic stored before we tracked names, which is exactly when the
	 * one-off validating rename is wanted anyway.
	 */
	private async adopt(
		threadId: number,
		name: string,
		currentName?: string,
	): Promise<boolean> {
		if (currentName !== name) {
			try {
				await this.deps.api.editForumTopic({
					chat_id: this.deps.ownerChatId,
					message_thread_id: threadId,
					name,
				});
				return true;
			} catch {
				return false; // TOPIC_ID_INVALID — the topic is gone; the caller recreates it.
			}
		}
		return true;
	}

	/** Persisted ids for THIS owner, in either layout (the old one is adopted). */
	/**
	 * The ids stored for THIS owner.
	 *
	 * It used to adopt an older on-disk shape here (`chat`/`log`, before they were renamed
	 * to `personal`/`manager`). That belongs to the migration now — a reader that quietly
	 * understands two shapes is a reader that will be asked to understand three.
	 */
	private async load(): Promise<TopicsState | null> {
		const stored = await this.deps.store.loadTopics();
		if (!stored || stored.ownerChatId !== this.deps.ownerChatId) return null;
		if (stored.personal === undefined || stored.manager === undefined)
			return null;
		return stored;
	}

	private async save(state: TopicsState): Promise<void> {
		await this.deps.store.saveTopics(state);
	}
}
