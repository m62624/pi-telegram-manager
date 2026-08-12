import type { Message } from "@grammyjs/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import {
	ManagerController,
	type ManagerControllerDeps,
} from "../../../src/modes/manager/controller";
import { createBusinessStore } from "../../../src/storage/business-store";
import { createChatState } from "../../../src/storage/chat-state";
import { createChatStore } from "../../../src/storage/chat-store";
import { createContactStore } from "../../../src/storage/contact-store";
import {
	MEMORY_EPISODE_ENTITY,
	MEMORY_EPISODE_RELATION,
} from "../../../src/storage/memory";
import { createTelegramPaths } from "../../../src/storage/paths";
import { FakeFs } from "../../helpers/fake-fs";
import { type TempMemory, tempMemory } from "../../helpers/temp-memory";

/**
 * The manager against the real engine, end to end.
 *
 * Everywhere else the controller runs on `FakeMemoryWorkspace`, which is the right
 * trade for tests about turn-taking. This one exists because a fake can agree with
 * itself: it ties the runtime to the engine that actually ships, over real files, so a
 * drift between the two shows up here rather than in somebody's chat.
 */

const OWNER_ID = 999;
const CONN = "conn-1";

let memory: TempMemory | null = null;

afterEach(async () => {
	await memory?.dispose();
	memory = null;
});

function message(text: string, chatId: number, fromId: number, id: number) {
	return {
		message_id: id,
		date: 0,
		chat: { id: chatId, type: "private", first_name: "Someone" },
		from: { id: fromId, is_bot: false, first_name: "Someone" },
		text,
	} as Message;
}

async function setup() {
	const fs = new FakeFs();
	const paths = createTelegramPaths("/agent");
	const clock = new ManualClock(0);
	const chatState = createChatState(fs, paths.chatStatePath);
	const businessStore = createBusinessStore(fs, paths.businessPath);
	await businessStore.upsert({
		id: CONN,
		userId: String(OWNER_ID),
		isEnabled: true,
		connectedAt: 0,
		updatedAt: 0,
	});
	memory = tempMemory();
	const deps: ManagerControllerDeps = {
		instructions: { base: "RULES", firstMessage: "FIRST", reopen: "AGAIN" },
		labeler: "LLM agent:",
		mentionWords: [],
		rememberMessages: 20,
		maxCharsPerMessage: 4000,
		maxContextChars: 40000,
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		factConsolidationQuietMs: 1_800_000,
		recallTokenBudget: 512,
		recallK: 0,
		consolidationLimits: { maxSteps: 12, maxNudges: 2 },
		episodes: true,
		liveFreshnessMs: 120_000,
		reopenAfterMs: 86_400_000,
		reviseThreshold: 2,
		strictReplyGuard: true,
		maxBytes: 52_428_800,
		media: { images: true, documents: false },
		clock,
		chatStore: createChatStore(fs, paths),
		contactStore: createContactStore(fs, paths),
		memory: memory.workspace,
		consolidationQueue: chatState.consolidationQueue,
		chatCursors: chatState.cursors,
		sentRegistry: chatState.sentRegistry,
		businessStore,
		isIdle: () => true,
		triggerAgent: vi.fn(async () => {}),
		sendReply: vi.fn(async () => [1]),
		typing: vi.fn(async () => {}),
	};
	return { controller: new ManagerController(deps), clock, workspace: memory };
}

describe("the manager on a real memory", () => {
	it("remembers one person's conversation without it reaching another's", async () => {
		const { controller, clock, workspace } = await setup();

		// Alice writes, is answered, and says something worth keeping.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: message("I moved to Berlin last month", 42, 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		const tools = controller.memoryToolContext();
		const alice = await tools.active();
		expect(alice).not.toBeNull();
		await alice?.remember({
			text: "lives in Berlin",
			entity: "Someone",
			tags: ["fact", "identity"],
		});
		controller.decisionSink().record({ kind: "reply", text: "Noted!" });
		await controller.onAgentEnd();

		// Bob writes into a different chat. His turn must not be able to see any of it.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "43",
			fromId: 6,
			message: message("where do you live?", 43, 6, 2),
		});
		clock.advance(300_001);
		await controller.onTick();
		const bobsTurn = await controller.buildContextForActive();
		const bobsPrompt = (bobsTurn ?? []).map((m) => m.content).join("\n");
		expect(bobsPrompt).not.toContain("Berlin");

		// Alice's own memory did keep it, and it reaches her next turn.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "43",
			fromId: 6,
			message: message("never mind", 43, 6, 3),
		});
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: message("remind me where I said I live?", 42, 5, 4),
		});
		clock.advance(300_001);
		await controller.onTick();
		const aliceTurn = await controller.buildContextForActive();
		expect(aliceTurn?.at(-1)?.content).toContain("lives in Berlin");

		// And it is really on disk, in a database of her own.
		const reopened = await workspace.workspace.for("5");
		expect((await reopened.recall({ query: "Berlin" })).rendered).toContain(
			"lives in Berlin",
		);
	});

	it("keeps a message the transcript will eventually prune", async () => {
		const { controller, workspace } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: message("the invoice number is 7781", 42, 5, 1),
		});
		// The JSONL transcript is compacted to twice the reading window; the memory is
		// what still answers about this conversation a month from now.
		//
		// Anchored on the entity, because tags FILTER a recall — they are not a source it
		// can rank by. A query of tags alone has nothing to search on and answers with
		// nothing, which is worth knowing before writing one by hand.
		const stored = await workspace.workspace.for("5");
		const episodes = await stored.recall({
			entities: ["Someone"],
			tags: ["episode"],
		});
		expect(episodes.rendered).toContain("invoice number is 7781");
		expect((await stored.recall({ tags: ["episode"] })).rendered).toBe("");
		// Reached through the edge, not because it is filed under her: the message is a
		// `chat log` fact, and the recall above walked one hop to find it. Filed under
		// the contact it would sit in the way of every guarded write about her.
		expect(episodes.rendered).toContain(MEMORY_EPISODE_ENTITY);
		expect(episodes.rendered).toContain(
			`Someone —${MEMORY_EPISODE_RELATION}→ ${MEMORY_EPISODE_ENTITY}`,
		);
	});
});
