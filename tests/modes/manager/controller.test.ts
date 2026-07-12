import type { BusinessConnection, Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import {
	ManagerController,
	type ManagerControllerDeps,
} from "../../../src/modes/manager/controller";
import { createBusinessStore } from "../../../src/storage/business-store";
import { createChatStore } from "../../../src/storage/chat-store";
import { createConsolidationQueue } from "../../../src/storage/consolidation-queue";
import { createContactStore } from "../../../src/storage/contact-store";
import { createTelegramPaths } from "../../../src/storage/paths";
import { createSentRegistry } from "../../../src/storage/sent-registry";
import type { ManagerSubMode } from "../../../src/storage/singleton-store";
import { FakeFs } from "../../helpers/fake-fs";

const OWNER_ID = 999;
const CONN = "conn-1";

function interlocutorMsg(text: string, fromId = 5, messageId = 1): Message {
	return {
		message_id: messageId,
		date: 0,
		chat: { id: 42, type: "private", first_name: "Alice" },
		from: { id: fromId, is_bot: false, first_name: "Alice" },
		text,
	} as Message;
}

function ownerMsg(text: string, messageId = 100): Message {
	return {
		message_id: messageId,
		date: 0,
		chat: { id: 42, type: "private", first_name: "Alice" },
		from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
		text,
	} as Message;
}

async function setup(
	subMode: ManagerSubMode = "observer",
	mentionWords: string[] = [],
) {
	const fs = new FakeFs();
	const paths = createTelegramPaths("/agent");
	const clock = new ManualClock(0);
	const businessStore = createBusinessStore(fs, paths.businessPath);
	await businessStore.upsert({
		id: CONN,
		userId: String(OWNER_ID),
		isEnabled: true,
		connectedAt: 0,
		updatedAt: 0,
	});
	const triggerAgent = vi.fn(async () => {});
	const typing = vi.fn(async () => {});
	let nextId = 500;
	const sendReply = vi.fn(async () => [nextId++]);
	let idle = true;
	const deps: ManagerControllerDeps = {
		subMode,
		instructions: {
			base: "BASE MANAGER RULES",
			firstMessage: "FIRST CONTACT",
			reopen: "WELCOME BACK",
		},
		labeler: "LLM agent:",
		mentionWords,
		rememberMessages: 20,
		maxCharsPerMessage: 4000,
		maxContextChars: 40000,
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		factsLimit: 20,
		factConsolidationQuietMs: 1_800_000,
		verifyLimit: 8,
		liveFreshnessMs: 120_000,
		reopenAfterMs: 86_400_000,
		reviseThreshold: 2,
		strictReplyGuard: true,
		maxBytes: 52_428_800,
		media: { images: true, documents: false },
		clock,
		chatStore: createChatStore(fs, paths),
		contactStore: createContactStore(fs, paths),
		consolidationQueue: createConsolidationQueue(
			fs,
			paths.consolidationQueuePath,
		),
		sentRegistry: createSentRegistry(fs, paths.sentRegistryPath),
		businessStore,
		isIdle: () => idle,
		triggerAgent,
		sendReply,
		typing,
	};
	const controller = new ManagerController(deps);
	return {
		controller,
		deps,
		triggerAgent,
		typing,
		sendReply,
		clock,
		setIdle: (v: boolean) => {
			idle = v;
		},
	};
}

describe("ManagerController", () => {
	it("holds a message for the owner-reply window, then triggers after it lapses", async () => {
		const { controller, triggerAgent, typing, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello"),
		});
		// Not delivered to the model yet — the owner gets first crack.
		expect(triggerAgent).not.toHaveBeenCalled();
		expect(controller.status().activeChat).toBeUndefined();
		// Owner stays silent past the window → the chat is served.
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
		expect(typing).toHaveBeenCalledWith({ connectionId: CONN, chatId: "42" });
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 0 });
	});

	it("delivers manager_reply text on turn end, labelled + bot-tagged + recorded", async () => {
		const { controller, sendReply, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Hello there!" });
		await controller.onAgentEnd();

		expect(sendReply).toHaveBeenCalledTimes(1);
		const sent = sendReply.mock.calls[0][0];
		// The controller passes the RAW text; labeler/marker/HTML are applied by the
		// send layer (see reply-format.test.ts).
		expect(sent.text).toBe("Hello there!");
		// recorded as bot-sent so it won't be mistaken for the owner later
		expect(await deps.sentRegistry.wasSentByBot("42", 500)).toBe(true);
		const stored = await deps.chatStore.all("42");
		expect(stored.at(-1)).toMatchObject({
			author: "bot",
			text: "Hello there!",
		});
	});

	it("threads the reply to the model's reply_to, else to the latest interlocutor message", async () => {
		const { controller, sendReply, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("first", 5, 11),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("second", 5, 12),
		});
		clock.advance(300_001);
		await controller.onTick();

		// No reply_to → threads to the latest interlocutor message (#12).
		controller.decisionSink().record({ kind: "reply", text: "ok" });
		await controller.onAgentEnd();
		expect(sendReply.mock.calls[0][0].replyToMessageId).toBe(12);

		// Explicit valid reply_to → threads to that message (#11).
		controller.decisionSink().record({
			kind: "reply",
			text: "about the first",
			replyTo: 11,
		});
		await controller.onAgentEnd();
		expect(sendReply.mock.calls[1][0].replyToMessageId).toBe(11);
	});

	it("does not skip a message that arrives mid-turn — holds the draft and reconsiders", async () => {
		const { controller, sendReply, triggerAgent, setIdle, clock } =
			await setup();
		// Chat 42 becomes active and a turn starts.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("first question", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(controller.status().activeChat).toBe("42");
		const triggersAfterStart = triggerAgent.mock.calls.length;

		// A new message lands WHILE the agent is generating (busy).
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("wait, also this", 5, 2),
		});

		// The model drafts a reply to the first question; the turn ends.
		setIdle(true);
		controller
			.decisionSink()
			.record({ kind: "reply", text: "answer to first" });
		await controller.onAgentEnd();

		// Nothing sent yet — the draft is held and the turn is re-triggered.
		expect(sendReply).not.toHaveBeenCalled();
		expect(triggerAgent.mock.calls.length).toBe(triggersAfterStart + 1);

		// The reconsider turn is a REVISE turn: it surfaces the draft + the newer
		// message and asks the model to resolve it with manager_resolve_draft.
		const ctx = await controller.buildContextForActive();
		const directive = ctx?.at(-1)?.content ?? "";
		expect(directive).toContain("answer to first");
		expect(directive).toContain("manager_resolve_draft");
		expect(ctx?.some((m) => m.content.includes("wait, also this"))).toBe(true);
		expect(controller.isReviseTurn()).toBe(true);

		// The model refines the draft (no new mid-turn message this time) → delivered.
		controller
			.resolveSink()
			.record({ action: "refine", text: "answer to both" });
		await controller.onAgentEnd();
		expect(sendReply).toHaveBeenCalledTimes(1);
		expect(sendReply.mock.calls[0][0].text).toContain("answer to both");
	});

	it("caps the revise loop: after reviseThreshold reconsiders the draft is sent as-is", async () => {
		// reviseThreshold defaults to 2 in setup: the draft may be held twice, then
		// the third mid-turn arrival still sends it rather than deferring forever.
		const { controller, sendReply, setIdle, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("q1", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();

		// First turn: a normal reply is drafted, a mid-turn message arrives → held.
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("more 2", 5, 2),
		});
		setIdle(true);
		controller.decisionSink().record({ kind: "reply", text: "draft 1" });
		await controller.onAgentEnd();

		// Two revise turns: the model refines each time, but a fresh message keeps
		// landing mid-turn, so the draft is held again — until the cap is reached.
		for (let i = 3; i <= 4; i += 1) {
			expect(controller.isReviseTurn()).toBe(true);
			setIdle(false);
			await controller.onBusinessMessage({
				connectionId: CONN,
				chatId: "42",
				fromId: 5,
				message: interlocutorMsg(`more ${i}`, 5, i),
			});
			setIdle(true);
			controller
				.resolveSink()
				.record({ action: "refine", text: `draft ${i - 1}` });
			await controller.onAgentEnd();
		}

		// Held twice (cycles 1 and 2); the third revise hit the cap and delivered.
		expect(sendReply).toHaveBeenCalledTimes(1);
		expect(sendReply.mock.calls[0][0].text).toContain("draft 3");
	});

	it("recovers a reply the model wrote as plain text: re-prompts once, then delivers it", async () => {
		const { controller, sendReply, triggerAgent, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("are you there?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		const triggersAfterStart = triggerAgent.mock.calls.length;

		// The model ends in plain text with no tool call → held, re-prompted once.
		await controller.onAgentEnd("Yes, I am here.");
		expect(sendReply).not.toHaveBeenCalled();
		expect(triggerAgent.mock.calls.length).toBe(triggersAfterStart + 1);
		const ctx = await controller.buildContextForActive();
		expect(ctx?.at(-1)?.content).toContain("plain text");

		// It writes prose again → the text is delivered verbatim instead of dropped.
		await controller.onAgentEnd("Still here, what do you need?");
		expect(sendReply).toHaveBeenCalledTimes(1);
		expect(sendReply.mock.calls[0][0].text).toContain(
			"Still here, what do you need?",
		);
	});

	it("returns a turn log describing the decision (for the owner debug feed)", async () => {
		const { controller, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("need the invoice?", 5, 3),
		});
		clock.advance(300_001);
		await controller.onTick();

		controller.decisionSink().record({
			kind: "reply",
			text: "Sure, sending it.",
			category: "question",
		});
		const replyLog = await controller.onAgentEnd();
		expect(replyLog).toMatchObject({
			chatId: "42",
			outcome: "reply",
			text: "Sure, sending it.",
			category: "question",
			replyToMessageId: 3,
		});

		// A silent turn reports the reason; an idle slot reports nothing.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("cool", 5, 4),
		});
		controller.decisionSink().record({
			kind: "silent",
			reason: "just an acknowledgement",
		});
		const silentLog = await controller.onAgentEnd();
		expect(silentLog).toMatchObject({
			outcome: "silent",
			text: "just an acknowledgement",
		});
		expect(await controller.onAgentEnd()).toBeNull();
	});

	it("strict guard drops a chatter reply the model was not addressed in", async () => {
		const { controller, sendReply, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("haha nice one 😂", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		// The model tried to reply, but tagged it chatter and not addressed → dropped.
		controller.decisionSink().record({
			kind: "reply",
			text: "Glad you liked it!",
			category: "chatter",
			needsReply: false,
		});
		const log = await controller.onAgentEnd();
		expect(sendReply).not.toHaveBeenCalled();
		expect(log).toMatchObject({ outcome: "silent" });
	});

	it("strict guard lets an addressed reply through", async () => {
		const { controller, sendReply } = await setup("observer", ["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hey llm, you around? 😂", 5, 1),
		});
		await controller.onTick();
		// Even tagged chatter, a wake-word in the message means it is addressed.
		controller.decisionSink().record({
			kind: "reply",
			text: "Yep, here!",
			category: "chatter",
		});
		await controller.onAgentEnd();
		expect(sendReply).toHaveBeenCalledTimes(1);
	});

	it("greets a chat resuming after a long silence with the reopen template", async () => {
		const { controller, clock } = await setup();
		// Establish history: an interlocutor message and a bot reply.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "hey!" });
		await controller.onAgentEnd();

		// ~25h later they write again (chat still active) → treated as a re-opening.
		clock.advance(90_000_000);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("you around?", 5, 2),
		});

		const ctx = await controller.buildContextForActive();
		expect(ctx?.[0].content).toContain("WELCOME BACK");
		expect(ctx?.[0].content).not.toContain("FIRST CONTACT");
	});

	it("fast-tracks an interlocutor wake-word past the owner-reply window", async () => {
		const { controller, triggerAgent } = await setup("observer", ["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hey llm, are you there?"),
		});
		// Ready immediately — no 5-minute hold, no clock advance.
		expect(controller.status()).toMatchObject({ activeChat: "42", holding: 0 });
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
		// The model is nudged to judge whether it is really addressed.
		const ctx = await controller.buildContextForActive();
		expect(ctx?.at(-1)?.content).toContain("wake-word");
	});

	it("mixed/coding priority: a wake-word is held while the brain is busy, served once idle", async () => {
		// In mixed mode's coding polarity the manager's isIdle is false, so a
		// wake-word may make the chat ready but must NOT preempt the owner's coding —
		// unlike the standalone manager, it waits for the return-timer to free the brain.
		const { controller, triggerAgent, setIdle } = await setup("observer", [
			"llm",
		]);
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("llm, urgent please"),
		});
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
		// The brain frees up (polarity flips back to Telegram) → the ready chat runs.
		setIdle(true);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});

	it("without a wake-word the interlocutor still waits out the owner window", async () => {
		const { controller } = await setup("observer", ["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("just chatting here"),
		});
		expect(controller.status()).toMatchObject({
			activeChat: undefined,
			holding: 1,
		});
	});

	it("observer: an owner wake-word summons the bot immediately", async () => {
		const { controller, triggerAgent } = await setup("observer", ["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("llm, please reply to them"),
		});
		expect(controller.status().activeChat).toBe("42");
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});

	it("takeover: an owner wake-word is ignored (owner presence still freezes)", async () => {
		const { controller, triggerAgent } = await setup("takeover", ["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("llm, do this"),
		});
		expect(controller.status().activeChat).toBeUndefined();
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
	});

	it("stays silent when the model chooses manager_silent (no send)", async () => {
		const { controller, sendReply } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();
		expect(sendReply).not.toHaveBeenCalled();
	});

	it("ignores the bot's own outgoing echo (does not freeze/queue)", async () => {
		const { controller, triggerAgent, deps } = await setup("takeover");
		// Simulate a prior bot send recorded in the registry.
		await deps.sentRegistry.recordSent("42", 500);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("echo", 500),
		});
		expect(triggerAgent).not.toHaveBeenCalled();
		expect(controller.status().activeChat).toBeUndefined();
	});

	it("takeover: a manual owner message freezes the chat so the bot stays silent", async () => {
		const { controller, triggerAgent } = await setup("takeover");
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("I'll handle this"),
		});
		expect(triggerAgent).not.toHaveBeenCalled();
		// Now the interlocutor writes; frozen → no turn.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("still there?", 5, 2),
		});
		expect(triggerAgent).not.toHaveBeenCalled();
	});

	it("takeover: the bot re-engages after the owner-reply window lapses", async () => {
		const { controller, triggerAgent, clock } = await setup("takeover");
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("mine"),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello?", 5, 2),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});

	it("records a backlog message for context but does not open a live cycle", async () => {
		const { controller, triggerAgent, deps, clock } = await setup();
		clock.advance(1_000_000); // now = 1,000,000 ms
		// True send time 1000 ms — far older than liveFreshnessMs (120 s).
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				...interlocutorMsg("yesterday's backlog"),
				date: 1,
			} as Message,
		});
		// Stored in the transcript, but never queued/held and never triggers a turn.
		expect((await deps.chatStore.all("42")).length).toBe(1);
		expect(controller.status().holding).toBe(0);
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
		expect(controller.status().activeChat).toBeUndefined();

		// A fresh message (true send time ≈ now) does open the owner-reply window.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				...interlocutorMsg("live now", 5, 2),
				date: Math.floor(clock.now() / 1000),
			} as Message,
		});
		expect(controller.status().holding).toBe(1);
	});

	it("builds an isolated context for the active chat only", async () => {
		const { controller, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi there"),
		});
		clock.advance(300_001);
		await controller.onTick();
		const ctx = await controller.buildContextForActive();
		// First message = the system-instruction block (rules + first-contact).
		expect(ctx?.[0].content).toContain("[SYSTEM_INSTRUCTIONS]");
		expect(ctx?.[0].content).toContain("BASE MANAGER RULES");
		expect(ctx?.[0].content).toContain("FIRST CONTACT");
		// The chat boundary and the interlocutor's line are present in the middle.
		expect(ctx?.some((m) => m.content.includes("New chat with Alice"))).toBe(
			true,
		);
		expect(
			ctx?.some((m) => m.content === "[#1] Interlocutor (Alice): hi there"),
		).toBe(true);
		// The turn ends with the action directive that forces a tool call.
		expect(ctx?.at(-1)?.content).toContain("manager_reply");
	});

	it("carries reply/forward context of an interlocutor message into the context", async () => {
		const { controller, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				message_id: 3,
				date: 0,
				chat: { id: 42, type: "private", first_name: "Alice" },
				from: { id: 5, is_bot: false, first_name: "Alice" },
				text: "yes, that one",
				reply_to_message: {
					message_id: 2,
					date: 0,
					chat: { id: 42, type: "private", first_name: "Alice" },
					from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
					text: "the blue one?",
				},
			} as Message,
		});
		clock.advance(300_001);
		await controller.onTick();
		const ctx = await controller.buildContextForActive();
		const interlocutor = ctx?.find((m) => m.content.includes("yes, that one"));
		expect(interlocutor?.content).toContain(
			'[reply to Owner]: "the blue one?"',
		);
	});

	it("queues a second chat (per-user) while the first is active", async () => {
		const { controller, triggerAgent, setIdle, clock } = await setup();
		// Chat 42's window lapses first → it becomes active.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("first"),
		});
		clock.advance(300_001);
		setIdle(false); // agent now busy on chat 42
		await controller.onTick();
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 0 });
		// Chat 43 arrives and its window lapses while 42 is still being served.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "43",
			fromId: 6,
			message: {
				message_id: 9,
				date: 0,
				chat: { id: 43, type: "private", first_name: "Bob" },
				from: { id: 6, is_bot: false, first_name: "Bob" },
				text: "second",
			} as Message,
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled(); // busy → nothing dispatched
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 1 });
	});

	it("releases a queued chat the owner answered instead of stalling on it", async () => {
		const { controller, triggerAgent, setIdle, clock } = await setup();
		// Chat 42 becomes active while the agent is busy.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		setIdle(false);
		await controller.onTick();
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 0 });
		// Chat 43 queues behind it.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "43",
			fromId: 6,
			message: {
				message_id: 9,
				date: 0,
				chat: { id: 43, type: "private", first_name: "Bob" },
				from: { id: 6, is_bot: false, first_name: "Bob" },
				text: "hey",
			} as Message,
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 1 });
		// The owner answers chat 43 manually while it waits.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "43",
			fromId: OWNER_ID,
			message: {
				message_id: 10,
				date: 0,
				chat: { id: 43, type: "private", first_name: "Bob" },
				from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
				text: "got it",
			} as Message,
		});
		// Chat 42 finishes silent; 43 must not stall the active slot.
		setIdle(true);
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();
		expect(controller.status().activeChat).toBeUndefined();
		expect(triggerAgent).not.toHaveBeenCalled();
	});

	it("injects known facts and a [Now:] line into the context", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		await deps.contactStore.appendFacts(
			"5",
			[{ text: "likes green tea", timestamp: 0, source: "manager" }],
			20,
		);
		clock.advance(300_001);
		await controller.onTick();
		const ctx = await controller.buildContextForActive();
		expect(ctx?.[0].content).toContain("Known facts about Alice");
		expect(ctx?.[0].content).toContain("likes green tea");
		// The clock lives in the trailing directive, not the cacheable prefix block.
		expect(ctx?.[0].content).not.toContain("[Now:");
		expect(ctx?.at(-1)?.content).toContain("[Now:");
	});

	it("groups known facts into per-kind sections with their directives", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		await deps.contactStore.appendFacts(
			"5",
			[
				{
					text: "name is Alice",
					timestamp: 0,
					source: "manager",
					kind: "identity",
				},
				{
					text: "prefers Russian",
					timestamp: 0,
					source: "manager",
					kind: "preference",
				},
				{
					text: "promised a quote by Friday",
					timestamp: 0,
					source: "manager",
					kind: "agreement",
				},
			],
			20,
		);
		clock.advance(300_001);
		await controller.onTick();
		const system =
			(await controller.buildContextForActive())?.[0].content ?? "";
		// Each kind is its own section with the behaviour it steers.
		expect(system).toContain("Who they are");
		expect(system).toContain("address them correctly");
		expect(system).toContain("Preferences");
		expect(system).toContain("Adapt your tone");
		expect(system).toContain("Agreements");
		expect(system).toContain("proactively follow up");
	});

	it("persists facts recorded via manager_remember on turn end", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller
			.factSink()
			.record([
				{ text: "name is Bob", subject: "interlocutor", kind: "identity" },
			]);
		controller.decisionSink().record({ kind: "reply", text: "Hello Bob" });
		await controller.onAgentEnd();
		const facts = await deps.contactStore.getFacts("5");
		expect(facts.map((f) => f.text)).toContain("name is Bob");
	});

	it("firewall: keeps only interlocutor-tagged facts, stamped with contact + kind", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.factSink().record([
			{ text: "keeps this", subject: "interlocutor", kind: "preference" },
			{ text: "owner detail", subject: "owner" },
			{ text: "third party", subject: "other" },
		]);
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();
		const facts = await deps.contactStore.getFacts("5");
		expect(facts.map((f) => f.text)).toEqual(["keeps this"]);
		expect(facts[0]).toMatchObject({ subject: "Alice", kind: "preference" });
	});

	it("firewall: never writes facts into the owner's own card (self-test)", async () => {
		const { controller, deps } = await setup();
		// A chat keyed by the owner's own id — the owner messaged their own bot.
		controller.markReady("owner-chat", {
			connectionId: CONN,
			contactName: "Owner",
			userId: String(OWNER_ID),
		});
		controller
			.factSink()
			.record([{ text: "should not persist", subject: "interlocutor" }]);
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();
		expect(await deps.contactStore.getFacts(String(OWNER_ID))).toEqual([]);
	});

	it("gates a revise turn on resolve-draft: manager_silent cannot drop a held answer", async () => {
		const { controller, sendReply, setIdle, clock } = await setup();
		// A real question arrives and a turn starts.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("how do I start in valheim?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();

		// A trailing chatter message lands mid-turn; the model drafts the real answer.
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("we'll see", 5, 2),
		});
		setIdle(true);
		controller
			.decisionSink()
			.record({ kind: "reply", text: "chop wood, craft a workbench" });
		await controller.onAgentEnd(); // held → revise turn
		expect(sendReply).not.toHaveBeenCalled();
		expect(controller.isReviseTurn()).toBe(true);

		// The model reflexively calls manager_silent on the trailing chatter — the gate
		// must NOT let that end the turn or drop the drafted answer (the Valheim bug).
		controller
			.decisionSink()
			.record({ kind: "silent", category: "chatter", needsReply: false });
		expect(controller.turnDecided()).toBe(false);

		// Only manager_resolve_draft ends a revise turn; the model sends the draft.
		controller.resolveSink().record({ action: "send" });
		expect(controller.turnDecided()).toBe(true);
		await controller.onAgentEnd();
		expect(sendReply).toHaveBeenCalledTimes(1);
		expect(sendReply.mock.calls[0][0].text).toContain("workbench");
	});

	it("drops a held draft only on an explicit resolve 'drop'", async () => {
		const { controller, sendReply, setIdle, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("what time is it?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("nvm, found it", 5, 2),
		});
		setIdle(true);
		controller.decisionSink().record({ kind: "reply", text: "it is 3pm" });
		await controller.onAgentEnd(); // held → revise turn
		expect(controller.isReviseTurn()).toBe(true);

		// They retracted, so the model drops the draft — nothing is sent.
		controller
			.resolveSink()
			.record({ action: "drop", reason: "they answered themselves" });
		await controller.onAgentEnd();
		expect(sendReply).not.toHaveBeenCalled();
		expect(controller.status().activeChat).not.toBe("42");
	});

	it("drives the consolidation interrogation probe-by-probe and persists verified facts", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("i just ordered a laptop for work"),
		});
		clock.advance(300_001);
		await controller.onTick(); // chat 42 active, reply turn
		controller.decisionSink().record({ kind: "reply", text: "Hi!" });
		await controller.onAgentEnd(); // bot replied → 1:30 continuation + queued
		// Past the continuation window AND the 30-min quiet period.
		clock.advance(1_800_001);
		await controller.onTick(); // releases 42, then starts the interrogation

		// Probe 1 — identify.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 1 of 3");
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		await controller.onAgentEnd();

		// Probe 2 — candidates. Owner-tagged / non-durable ones are dropped by code.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 2 of 3");
		controller.probeSink().record({
			tool: "candidates",
			items: [
				{ text: "ordered a laptop", subject: "interlocutor", durable: true },
				{ text: "owner ships code", subject: "owner", durable: true },
				{
					text: "feeling tired today",
					subject: "interlocutor",
					durable: false,
				},
			],
		});
		await controller.onAgentEnd();

		// Probe 3 — per-fact verify (only the one surviving candidate).
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 3 of 3");
		controller.probeSink().record({
			tool: "verify",
			keep: true,
			evidenceQuote: "ordered a laptop",
		});
		await controller.onAgentEnd();

		const facts = await deps.contactStore.getFacts("5");
		expect(facts.map((f) => f.text)).toEqual(["ordered a laptop"]);
		expect(facts[0]).toMatchObject({ subject: "Alice" });
	});

	it("walks the whole interrogation in ONE run via turn_end stepping (no per-probe re-trigger)", async () => {
		const { controller, deps, triggerAgent, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("i just ordered a laptop for work"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Hi!" });
		await controller.onAgentEnd();
		clock.advance(1_800_001);
		await controller.onTick(); // starts the interrogation (one triggerAgent)
		const triggersAtStart = triggerAgent.mock.calls.length;

		// identify → step (no abort, no re-trigger): next context shows step 2.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 1 of 3");
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		expect(controller.stepConsolidation()).toBe("continue");

		// candidates → step.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 2 of 3");
		controller.probeSink().record({
			tool: "candidates",
			items: [
				{ text: "ordered a laptop", subject: "interlocutor", durable: true },
			],
		});
		expect(controller.stepConsolidation()).toBe("continue");

		// verify → step reaches done: the context tells the model to stop.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 3 of 3");
		controller.probeSink().record({
			tool: "verify",
			keep: true,
			evidenceQuote: "ordered a laptop",
		});
		expect(controller.stepConsolidation()).toBe("continue");
		expect(controller.turnDecided()).toBe(true);
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("already decided");

		// The whole interrogation ran WITHOUT re-triggering an agent per probe.
		expect(triggerAgent.mock.calls.length).toBe(triggersAtStart);

		// The single run ends → agent_end persists the verified fact.
		await controller.onAgentEnd();
		expect((await deps.contactStore.getFacts("5")).map((f) => f.text)).toEqual([
			"ordered a laptop",
		]);
	});

	it("pre-empts an in-flight consolidation for a live reply, then resumes from the next step", async () => {
		const { controller, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("i just ordered a laptop for work"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Hi!" });
		await controller.onAgentEnd();
		clock.advance(1_800_001);
		await controller.onTick(); // starts the interrogation (identify)
		expect(controller.isConsolidating()).toBe(true);

		// identify recorded; then a FRESH live message lands mid-run (grows unserved).
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		const fresh = {
			...interlocutorMsg("do you know a good laptop?", 5, 2),
			date: Math.floor(clock.now() / 1000),
		} as Message;
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: fresh,
		});
		// The step preserves the identify progress, then yields for the live work.
		expect(controller.stepConsolidation()).toBe("abort");
		await controller.onAgentEnd(); // finishConsolidationRun → pause
		expect(controller.isConsolidating()).toBe(false);

		// Serve the live message so the chat frees up again.
		clock.advance(300_001); // owner-reply window expires → chat 42 becomes ready
		await controller.onTick();
		controller.decisionSink().record({ kind: "silent" });
		await controller.onAgentEnd();

		// Idle again past the continuation window → the paused pass RESUMES from step 2
		// (identify was already done before the pause), not restarted at step 1.
		clock.advance(1_800_001);
		await controller.onTick();
		expect(controller.isConsolidating()).toBe(true);
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 2 of 3");
	});

	it("aborts the interrogation (saves nothing) when identify flags a self-chat", async () => {
		const { controller, deps, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Hi!" });
		await controller.onAgentEnd();
		clock.advance(1_800_001);
		await controller.onTick(); // starts the interrogation
		controller.probeSink().record({ tool: "identify", sameAsOwner: true });
		await controller.onAgentEnd();
		expect(await deps.contactStore.getFacts("5")).toEqual([]);
	});

	it("turnDecided() gates the loop on the terminal decision, not a bare remember", async () => {
		const { controller } = await setup();
		// Fresh normal turn: nothing decided yet.
		expect(controller.turnDecided()).toBe(false);
		// A durable-fact record alone is NOT terminal — the model may still reply.
		controller
			.factSink()
			.record([{ text: "name is Bob", subject: "interlocutor" }]);
		expect(controller.turnDecided()).toBe(false);
		// reply/silent ends the turn.
		controller.decisionSink().record({ kind: "silent" });
		expect(controller.turnDecided()).toBe(true);
	});

	it("swaps the action trigger for a done directive once decided (amnesia guard)", async () => {
		const { controller, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		clock.advance(300_001);
		await controller.onTick();
		// Before deciding, the trigger asks for a tool call.
		const before = await controller.buildContextForActive();
		expect(before?.at(-1)?.content).toContain("manager_reply");
		// After a decision, a re-sampled context tells the model to stop instead of
		// presenting byte-identical input that would repeat the same tool call.
		controller.decisionSink().record({ kind: "silent" });
		const after = await controller.buildContextForActive();
		expect(after?.at(-1)?.content).toContain("already decided");
		expect(after?.at(-1)?.content).not.toContain("manager_reply");
	});

	it("persists a business connection with the owner id", async () => {
		const { controller, deps } = await setup();
		const connection = {
			id: CONN,
			user: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
			user_chat_id: 42,
			date: 0,
			is_enabled: true,
			rights: { can_reply: true },
		} as unknown as BusinessConnection;
		await controller.onBusinessConnection({
			connectionId: CONN,
			connection,
			isEnabled: true,
		});
		const stored = await deps.businessStore.get(CONN);
		expect(stored?.userId).toBe(String(OWNER_ID));
		expect(stored?.canReply).toBe(true);
	});
});

describe("consolidation pause/resume under live work", () => {
	const isConsolidation = (call: unknown[]) =>
		typeof call[0] === "string" &&
		call[0].includes("Consolidate your long-term memory");
	const isLiveTurn = (call: unknown[]) =>
		typeof call[0] === "string" &&
		call[0].includes("Respond to the latest messages");
	const countConsolidation = (calls: unknown[][]) =>
		calls.filter(isConsolidation).length;

	it("pauses at a fragment boundary for a live reply, then resumes", async () => {
		const { controller, triggerAgent, clock, setIdle } = await setup(
			"observer",
			["llm"],
		);
		// Seed a contact and get its chat into the consolidation queue, then clear the
		// unanswered state (the owner replied) so nothing is waiting on a reply.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello there", 5, 1),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("i'll take this", 100),
		});

		// Quiet long enough → an idle tick starts consolidation (fragment 1).
		clock.advance(1_800_001);
		await controller.onTick();
		expect(countConsolidation(triggerAgent.mock.calls)).toBe(1);

		// Fragment 1 runs (identify). While it runs, a live, addressed message lands.
		setIdle(false);
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
			ownerLinesPresent: true,
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				...interlocutorMsg("hey llm, you there?", 5, 2),
				date: Math.floor(clock.now() / 1000),
			},
		});

		// The fragment's turn ends → consolidation pauses and the live chat is served
		// (a live turn, NOT another consolidation probe).
		setIdle(true);
		await controller.onAgentEnd();
		expect(countConsolidation(triggerAgent.mock.calls)).toBe(1);
		expect(isLiveTurn(triggerAgent.mock.calls.at(-1) as unknown[])).toBe(true);

		// The live turn ends silent → the chat is served and the manager goes idle.
		setIdle(false);
		controller
			.decisionSink()
			.record({ kind: "silent", reason: "not addressed" });
		setIdle(true);
		await controller.onAgentEnd();

		// Idle again → consolidation resumes from where it paused (a 2nd probe).
		await controller.onTick();
		expect(countConsolidation(triggerAgent.mock.calls)).toBe(2);
	});

	it("skips (and dequeues) consolidation for the owner's own chat, by userId", async () => {
		const { controller, triggerAgent, deps, clock } = await setup();
		// A self-chat queued for consolidation: its userId is the business owner's,
		// so no matter what its display name is, code must decide it is the owner and
		// never run the identify probe on it.
		await deps.consolidationQueue.upsert({
			chatId: "self",
			userId: String(OWNER_ID),
			activityAt: 0,
		});
		clock.advance(1_800_001); // past factConsolidationQuietMs
		await controller.onTick();
		// No interrogation turn was started, and the self-chat was dropped from the queue.
		expect(triggerAgent).not.toHaveBeenCalled();
		expect(await deps.consolidationQueue.all()).toHaveLength(0);
	});
});
