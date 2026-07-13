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
		editForumTopic: vi.fn(async () => ({})),
		sendChatAction: vi.fn(async () => ({})),
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
		expect(r.isManager(101)).toBe(true);
		expect(r.isManager(100)).toBe(false);
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

	it("recreates a topic the owner deleted while the bot was off", async () => {
		const fs = new FakeFs();
		await router(api, fs).router.ensure();
		// The chat topic is gone: probing it fails, the log topic still answers.
		const second = fakeApi({
			sendChatAction: vi.fn(async (args: { message_thread_id?: number }) => {
				if (args.message_thread_id === 100) throw new Error("thread not found");
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
		expect(api.editForumTopic).toHaveBeenCalledTimes(2);
		expect(r.thread("personal")).toBe(11);
		expect(r.thread("manager")).toBe(12);
	});
});
