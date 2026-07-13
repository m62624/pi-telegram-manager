import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopicRouter, type TopicsApi } from "../../src/telegram/topics";
import { FakeFs } from "../helpers/fake-fs";

const OWNER = 42;
const PATH = "/topics.json";

function fakeApi(overrides: Partial<TopicsApi> = {}, firstThread = 100) {
	let nextThread = firstThread;
	return {
		getMe: vi.fn(async () => ({ has_topics_enabled: true })),
		createForumTopic: vi.fn(
			async (_args: { chat_id: number; name: string }) => ({
				message_thread_id: nextThread++,
			}),
		),
		editForumTopic: vi.fn(
			async (_args: { message_thread_id: number; name?: string }) => ({}),
		),
		deleteForumTopic: vi.fn(
			async (_args: { chat_id: number; message_thread_id: number }) => ({}),
		),
		// What Telegram allows as a topic icon; anything else is refused.
		getForumTopicIconStickers: vi.fn(async () => [
			{ emoji: "💻", custom_emoji_id: "id-personal" },
			{ emoji: "📣", custom_emoji_id: "id-manager" },
			{ emoji: "📁", custom_emoji_id: "id-archive" },
		]),
		...overrides,
	} satisfies TopicsApi & Record<string, unknown>;
}

function router(api: TopicsApi, fs = new FakeFs(), onFallback = vi.fn()) {
	return {
		fs,
		onFallback,
		router: new TopicRouter({
			api,
			fs,
			path: PATH,
			ownerChatId: OWNER,
			options: {
				enabled: true,
				personalName: "personal",
				managerName: "manager",
			},
			onFallback,
		}),
	};
}

describe("TopicRouter", () => {
	let api: ReturnType<typeof fakeApi>;

	beforeEach(() => {
		api = fakeApi();
	});

	it("creates both topics (personal + manager) and routes each kind to its thread", async () => {
		const { router: r } = router(api);
		expect(await r.ensure()).toBe(true);
		expect(api.createForumTopic).toHaveBeenCalledTimes(2);
		expect(r.thread("personal")).toBe(100);
		expect(r.thread("manager")).toBe(101);
	});

	it("reuses the persisted threads on the next run instead of creating new ones", async () => {
		const fs = new FakeFs();
		expect(await router(api, fs).router.ensure()).toBe(true);
		const second = fakeApi();
		const r2 = router(second, fs).router;
		expect(await r2.ensure()).toBe(true);
		expect(second.createForumTopic).not.toHaveBeenCalled();
		expect(r2.thread("personal")).toBe(100);
		expect(r2.thread("manager")).toBe(101);
	});

	it("does not rename a topic that is already called that", async () => {
		// Regression: the liveness probe passed the name every start, so Telegram posted
		// "Pi Agent changed the topic name to personal" on every single start.
		const fs = new FakeFs();
		await router(api, fs).router.ensure();
		const second = fakeApi();
		expect(await router(second, fs).router.ensure()).toBe(true);
		// Probed (no fields = keep values), never renamed.
		expect(second.editForumTopic).toHaveBeenCalledTimes(2);
		for (const call of second.editForumTopic.mock.calls) {
			expect(call[0].name).toBeUndefined();
		}
	});

	it("renames when the configured name actually changed", async () => {
		const fs = new FakeFs();
		await router(api, fs).router.ensure();
		const second = fakeApi();
		const renamed = new TopicRouter({
			api: second,
			fs,
			path: PATH,
			ownerChatId: OWNER,
			options: { enabled: true, personalName: "me", managerName: "manager" },
		});
		expect(await renamed.ensure()).toBe(true);
		const renames = second.editForumTopic.mock.calls.filter(
			(call) => call[0].name !== undefined,
		);
		expect(renames).toHaveLength(1);
		expect(renames[0][0].name).toBe("me");
	});

	it("recreates a topic the owner deleted while the bot was off", async () => {
		const fs = new FakeFs();
		await router(api, fs).router.ensure();
		// The personal topic is gone: claiming it fails; the manager one still answers.
		const second = fakeApi({
			editForumTopic: vi.fn(async (args: { message_thread_id: number }) => {
				if (args.message_thread_id === 100) {
					throw new Error("Bad Request: message thread not found");
				}
				return {};
			}),
		});
		const r2 = router(second, fs).router;
		expect(await r2.ensure()).toBe(true);
		expect(second.createForumTopic).toHaveBeenCalledTimes(1);
		// A fresh topic id (the fake hands out 100 again), not a stale one.
		expect(r2.thread("personal")).toBe(100);
		expect(r2.thread("manager")).toBe(101);
	});

	it("falls back to the plain DM when the bot has no topic mode", async () => {
		const noTopics = fakeApi({ getMe: vi.fn(async () => ({})) });
		const { router: r, onFallback } = router(noTopics);
		expect(await r.ensure()).toBe(false);
		expect(r.active).toBe(false);
		expect(r.thread("personal")).toBeUndefined();
		expect(r.thread("manager")).toBeUndefined();
		expect(onFallback.mock.calls[0][0]).toContain("BotFather");
		expect(noTopics.createForumTopic).not.toHaveBeenCalled();
	});

	it("falls back to the plain DM when creating a topic fails", async () => {
		const broken = fakeApi({
			createForumTopic: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		const { router: r, onFallback } = router(broken);
		expect(await r.ensure()).toBe(false);
		expect(r.thread("manager")).toBeUndefined();
		expect(onFallback.mock.calls[0][0]).toContain("plain DM");
	});

	it("is inert while topics are disabled in settings", async () => {
		const fs = new FakeFs();
		const r = new TopicRouter({
			api,
			fs,
			path: PATH,
			ownerChatId: OWNER,
			options: {
				enabled: false,
				personalName: "personal",
				managerName: "manager",
			},
		});
		expect(await r.ensure()).toBe(false);
		expect(api.getMe).not.toHaveBeenCalled();
		expect(r.thread("personal")).toBeUndefined();
	});

	it("ignores threads persisted for a different owner", async () => {
		const fs = new FakeFs();
		await router(api, fs).router.ensure();
		const other = fakeApi();
		const r = new TopicRouter({
			api: other,
			fs,
			path: PATH,
			ownerChatId: 999,
			options: {
				enabled: true,
				personalName: "personal",
				managerName: "manager",
			},
		});
		expect(await r.ensure()).toBe(true);
		expect(other.createForumTopic).toHaveBeenCalledTimes(2);
	});

	it("fallBack() drops the threads so sends go to the plain DM again", async () => {
		const { router: r } = router(api);
		await r.ensure();
		r.fallBack();
		expect(r.active).toBe(false);
		expect(r.thread("manager")).toBeUndefined();
	});

	it("recognises a dead thread from Telegram's error", () => {
		expect(
			TopicRouter.isMissingThread(
				new Error(
					"GrammyError: Call to 'sendRichMessage' failed! (400: Bad Request: message thread not found)",
				),
			),
		).toBe(true);
		expect(
			TopicRouter.isMissingThread(new Error("429: Too Many Requests")),
		).toBe(false);
	});

	it("adopts and renames the old chat/log pair instead of creating new topics", async () => {
		// The topics were first shipped as `chat`/`log`; a rename must keep the same
		// threads (and their history) rather than leave two orphans behind.
		const fs = new FakeFs();
		await fs.writeText(
			PATH,
			JSON.stringify({ ownerChatId: OWNER, chat: 11, log: 12 }),
		);
		const { router: r } = router(api, fs);
		expect(await r.ensure()).toBe(true);
		expect(api.createForumTopic).not.toHaveBeenCalled();
		// Each adopted thread is probed, then renamed once (it had no stored name).
		const renames = api.editForumTopic.mock.calls.filter(
			(call) => call[0].name !== undefined,
		);
		expect(renames.map((call) => call[0].name)).toEqual([
			"personal",
			"manager",
		]);
		expect(r.thread("personal")).toBe(11);
		expect(r.thread("manager")).toBe(12);
	});
});

describe("TopicRouter.revalidate", () => {
	it("recreates the topics the owner deleted, so their message is not swallowed", async () => {
		// The owner deletes both topics and writes in the plain DM. The router still
		// pointed at the dead threads, and every send died with "message thread not
		// found" — the message vanished. Now an unexpected thread re-checks.
		const fs = new FakeFs();
		const api = fakeApi();
		const { router: r } = router(api, fs);
		expect(await r.ensure()).toBe(true);
		expect(r.thread("personal")).toBe(100);

		// Both topics are gone: the probe now fails.
		api.editForumTopic.mockRejectedValue(
			new Error("400: Bad Request: message thread not found"),
		);
		expect(await r.revalidate()).toBe(true);
		expect(r.thread("personal")).toBe(102);
		expect(r.thread("manager")).toBe(103);
		expect(api.createForumTopic).toHaveBeenCalledTimes(4);
	});

	it("keeps the live topics when they are still there", async () => {
		const api = fakeApi();
		const { router: r } = router(api);
		await r.ensure();
		expect(await r.revalidate()).toBe(true);
		expect(r.thread("personal")).toBe(100);
		expect(api.createForumTopic).toHaveBeenCalledTimes(2);
	});

	it("degrades to the plain DM when topics cannot be restored", async () => {
		const api = fakeApi();
		const { router: r } = router(api);
		await r.ensure();
		api.getMe.mockResolvedValue({ has_topics_enabled: false });
		expect(await r.revalidate()).toBe(false);
		expect(r.thread("personal")).toBeUndefined();
	});
});

describe("TopicRouter.recreate", () => {
	it("replaces the one topic a failed send proved dead, keeping the other", async () => {
		// A send that failed with "message thread not found" is the only reliable proof
		// that a topic is gone — the start-up probe cannot be trusted for it. So the
		// topic is rebuilt on the spot and the caller retries in the new thread.
		const api = fakeApi();
		const { router: r } = router(api);
		await r.ensure();
		expect(r.thread("manager")).toBe(101);

		const thread = await r.recreate("manager");
		expect(thread).toBe(102);
		expect(r.thread("manager")).toBe(102);
		// The personal topic is untouched.
		expect(r.thread("personal")).toBe(100);
		expect(r.active).toBe(true);
	});

	it("persists the new thread, so the next run reuses it", async () => {
		const fs = new FakeFs();
		const api = fakeApi();
		const { router: first } = router(api, fs);
		await first.ensure();
		await first.recreate("manager");

		const { router: second } = router(fakeApi(), fs);
		await second.ensure();
		expect(second.thread("manager")).toBe(102);
		expect(second.thread("personal")).toBe(100);
	});

	it("degrades to the plain DM when even creating a topic fails", async () => {
		const api = fakeApi();
		const { router: r } = router(api);
		await r.ensure();
		api.createForumTopic.mockRejectedValue(new Error("403: Forbidden"));
		expect(await r.recreate("manager")).toBeUndefined();
		expect(r.active).toBe(false);
		expect(r.thread("manager")).toBeUndefined();
	});
});

// A topic that lives on stops accepting ordinary messages from the phone: they are
// posted OUTSIDE it, with no message_thread_id, while a topic created minutes earlier
// takes them fine. Nothing announces when a topic goes that way, so every session
// simply starts in a fresh one — these tests pin down what happens to the old one.
describe("TopicRouter: a fresh personal topic every session", () => {
	/** One session: adopt what is on disk, rotate, and say whether a conversation happened. */
	async function session(fs: FakeFs, firstThread: number, spoke: boolean) {
		const api = fakeApi({}, firstThread);
		const r = router(api, fs).router;
		await r.ensure();
		await r.startSession();
		if (spoke) await r.markUsed();
		return { api, router: r };
	}

	it("leaves the topic it just created alone — it is already fresh", async () => {
		const fs = new FakeFs();
		const { api, router: r } = await session(fs, 100, false);

		// personal + manager, and nothing else: no second topic, no delete, no rename.
		expect(api.createForumTopic).toHaveBeenCalledTimes(2);
		expect(api.deleteForumTopic).not.toHaveBeenCalled();
		expect(r.thread("personal")).toBe(100);
	});

	it("archives a personal that holds a conversation, and drops the previous archive", async () => {
		const fs = new FakeFs();
		await session(fs, 100, true); // personal 100, and the owner spoke in it

		const second = await session(fs, 200, true); // rotates: personal 200, archive 100
		expect(second.router.thread("personal")).toBe(200);
		expect(second.api.editForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				message_thread_id: 100,
				name: "personal (archive)",
			}),
		);
		expect(second.api.deleteForumTopic).not.toHaveBeenCalled();

		const third = await session(fs, 300, true); // rotates: personal 300, archive 200
		expect(third.api.deleteForumTopic).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message_thread_id: 100 }),
		);
		expect(third.api.editForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				message_thread_id: 200,
				name: "personal (archive)",
			}),
		);
	});

	it("deletes a personal nobody spoke in, and leaves the archive alone", async () => {
		const fs = new FakeFs();
		await session(fs, 100, true); // a real conversation in 100
		await session(fs, 200, false); // rotates: personal 200 (archive 100), nothing said

		// A restart after a silent session: 200 is thrown away with its creation notice,
		// and the conversation in 100 must NOT be pushed out of the archive by it.
		const third = await session(fs, 300, false);
		expect(third.api.deleteForumTopic).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message_thread_id: 200 }),
		);
		expect(third.api.editForumTopic).not.toHaveBeenCalledWith(
			expect.objectContaining({ name: "personal (archive)" }),
		);
		expect(third.router.thread("personal")).toBe(300);
	});

	it("keeps the session's topic when a fresh one cannot be created", async () => {
		const fs = new FakeFs();
		await session(fs, 100, true);

		const api = fakeApi({}, 200);
		api.createForumTopic.mockRejectedValue(new Error("429: Too Many Requests"));
		const r = router(api, fs).router;
		await r.ensure();
		await r.startSession();

		expect(r.thread("personal")).toBe(100);
		expect(api.deleteForumTopic).not.toHaveBeenCalled();
		expect(api.editForumTopic).not.toHaveBeenCalledWith(
			expect.objectContaining({ name: "personal (archive)" }),
		);
	});
});

// The three chips must be told apart at a glance. Icons, not colours: a colour can
// only be set when a topic is created, and the archive is a renamed `personal`.
describe("TopicRouter: topic icons", () => {
	it("gives each topic its icon, and marks the archive when it renames it", async () => {
		const fs = new FakeFs();
		const first = fakeApi();
		const a = router(first, fs).router;
		await a.ensure();

		expect(first.createForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "personal",
				icon_custom_emoji_id: "id-personal",
			}),
		);
		expect(first.createForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "manager",
				icon_custom_emoji_id: "id-manager",
			}),
		);
		await a.markUsed();

		const second = fakeApi({}, 200);
		const b = router(second, fs).router;
		await b.ensure();
		await b.startSession();

		expect(second.editForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				message_thread_id: 100,
				name: "personal (archive)",
				icon_custom_emoji_id: "id-archive",
			}),
		);
	});

	it("falls back to the topic colours when Telegram offers no icons", async () => {
		const api = fakeApi({
			getForumTopicIconStickers: vi.fn(async () => {
				throw new Error("500: Internal Server Error");
			}),
		});
		const r = router(api).router;
		await r.ensure();

		expect(api.createForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({ name: "personal", icon_color: 7322096 }),
		);
		expect(api.createForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({ name: "manager", icon_color: 16478047 }),
		);
	});
});

// Telegram refuses to delete some topics with 400: TOPIC_ID_INVALID — one that survived
// the owner clearing the chat, for instance — while editForumTopic still answers `ok`
// for the same id, so nothing warns us. Swallowing that refusal turned the rotation into
// a chip factory: every switch added a topic and removed none.
describe("TopicRouter: a topic Telegram will not delete", () => {
	function refusing(ids: number[], firstThread: number) {
		return fakeApi(
			{
				deleteForumTopic: vi.fn(
					async (args: { chat_id: number; message_thread_id: number }) => {
						if (ids.includes(args.message_thread_id)) {
							throw new Error("400: Bad Request: TOPIC_ID_INVALID");
						}
						return {};
					},
				),
			},
			firstThread,
		);
	}

	it("names the undeletable topic for what it is, instead of a second `personal`", async () => {
		const fs = new FakeFs();
		const first = fakeApi();
		const a = router(first, fs).router;
		await a.ensure(); // personal 100

		// A silent session: 100 should be deleted — but Telegram will not have it.
		const second = refusing([100], 200);
		const b = router(second, fs).router;
		await b.ensure();
		await b.startSession();

		expect(b.thread("personal")).toBe(200);
		expect(second.editForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				message_thread_id: 100,
				name: "personal (closed)",
			}),
		);
	});

	it("retries it on the next session, and forgets it once it is gone", async () => {
		const fs = new FakeFs();
		await router(fakeApi(), fs).router.ensure(); // personal 100

		const second = refusing([100], 200);
		const b = router(second, fs).router;
		await b.ensure();
		await b.startSession(); // 100 refused → remembered

		// Next session: Telegram allows it now, so it is deleted and not carried further.
		const third = fakeApi({}, 300);
		const c = router(third, fs).router;
		await c.ensure();
		await c.startSession();

		expect(third.deleteForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({ message_thread_id: 100 }),
		);

		const fourth = fakeApi({}, 400);
		const d = router(fourth, fs).router;
		await d.ensure();
		await d.startSession();

		expect(fourth.deleteForumTopic).not.toHaveBeenCalledWith(
			expect.objectContaining({ message_thread_id: 100 }),
		);
	});

	it("keeps the archive when the previous one cannot be deleted", async () => {
		const fs = new FakeFs();
		const a = router(fakeApi(), fs).router;
		await a.ensure(); // personal 100
		await a.markUsed();

		const second = fakeApi({}, 200);
		const b = router(second, fs).router;
		await b.ensure();
		await b.startSession(); // personal 200, archive 100
		await b.markUsed();

		// 100 (the archive) is now undeletable: 200 still becomes the archive, and 100 is
		// renamed out of the way rather than left standing as a second `personal`.
		const third = refusing([100], 300);
		const c = router(third, fs).router;
		await c.ensure();
		await c.startSession();

		expect(c.thread("personal")).toBe(300);
		expect(third.editForumTopic).toHaveBeenCalledWith(
			expect.objectContaining({
				message_thread_id: 200,
				name: "personal (archive)",
			}),
		);
	});
});
