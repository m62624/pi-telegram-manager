import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopicRouter, type TopicsApi } from "../../src/telegram/topics";
import { FakeFs } from "../helpers/fake-fs";

const OWNER = 42;
const PATH = "/topics.json";

function fakeApi(overrides: Partial<TopicsApi> = {}) {
	let nextThread = 100;
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
