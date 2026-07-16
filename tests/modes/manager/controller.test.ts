import type { BusinessConnection, Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import { buildIsolatedMessages } from "../../../src/modes/manager/context-isolation";
import {
	ManagerController,
	type ManagerControllerDeps,
} from "../../../src/modes/manager/controller";
import { createBusinessStore } from "../../../src/storage/business-store";
import { createChatState } from "../../../src/storage/chat-state";
import { createChatStore, ownWords } from "../../../src/storage/chat-store";
import { createContactStore } from "../../../src/storage/contact-store";
import { createTelegramPaths } from "../../../src/storage/paths";
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

async function setup(mentionWords: string[] = []) {
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
	const triggerAgent = vi.fn(async () => {});
	const typing = vi.fn(async () => {});
	let nextId = 500;
	const sendReply = vi.fn(async () => [nextId++]);
	let idle = true;
	const deps: ManagerControllerDeps = {
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
		consolidationQueue: chatState.consolidationQueue,
		chatCursors: chatState.cursors,
		sentRegistry: chatState.sentRegistry,
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

	it("a plain-text answer is held as a draft and the strict guard cannot drop it", async () => {
		// Regression: the model wrote a real answer as plain text; re-deciding from
		// scratch, a weak model relabelled the question as chatter and strictReplyGuard
		// dropped the answer. Now the prose is held and routed through the resolve gate:
		// it is a REVISE turn (resolve_draft only), and a sent draft reads as a considered
		// reply (category question), so the chatter guard never fires on it.
		const { controller, sendReply, triggerAgent, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("how does the delivery fee work?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();

		// The model answers as plain text → held as a draft, not delivered yet.
		await controller.onAgentEnd("It is charged once per order, not per item.");
		expect(sendReply).not.toHaveBeenCalled();
		expect(controller.isReviseTurn()).toBe(true);
		// The revise turn must not be prompted for the tools it has disabled.
		const revisePrompt = triggerAgent.mock.calls.at(-1)?.[0] as string;
		expect(revisePrompt).toContain("manager_resolve_draft");
		expect(revisePrompt).not.toContain("manager_reply");
		const ctx = await controller.buildContextForActive();
		expect(ctx?.at(-1)?.content).toContain("plain text");
		expect(ctx?.at(-1)?.content).toContain("manager_resolve_draft");

		// The model resolves the held draft with 'send' → delivered despite the strict
		// guard (it is treated as a considered reply, never as chatter).
		controller.resolveSink().record({ action: "send" });
		await controller.onAgentEnd();
		expect(sendReply).toHaveBeenCalledTimes(1);
		expect(sendReply.mock.calls[0][0].text).toContain("once per order");
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
		const { controller, sendReply } = await setup(["llm"]);
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
		// The opener rides in the TRAILING message, not the head: it changes as the chat
		// progresses (first contact → nothing → re-opening), and anything above the
		// transcript that changes costs the whole transcript to re-read.
		expect(ctx?.at(-1)?.content).toContain("WELCOME BACK");
		expect(ctx?.at(-1)?.content).not.toContain("FIRST CONTACT");
		expect(ctx?.[0].content).not.toContain("WELCOME BACK");
	});

	it("fast-tracks an interlocutor wake-word past the owner-reply window", async () => {
		const { controller, triggerAgent } = await setup(["llm"]);
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

	it("loads a photo the owner REPLIES to when summoning the bot to look", async () => {
		const { controller, deps } = await setup(["квен"]);
		const loadImages = vi.fn(async () => [
			{ data: "PICDATA", mimeType: "image/jpeg" },
		]);
		deps.loadImages = loadImages;
		const photo = {
			message_id: 1,
			date: 0,
			chat: { id: 42, type: "private", first_name: "Alice" },
			from: { id: 5, is_bot: false, first_name: "Alice" },
			photo: [{ file_id: "PIC", file_size: 100 }],
		} as Message;
		// The owner replies to that photo and calls the bot in one message.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: {
				...ownerMsg("квен, что ты видишь?", 100),
				reply_to_message: photo,
			} as Message,
		});
		await controller.onTick();
		// The replied-to picture was fetched — from the replied message, not the summon.
		expect(loadImages).toHaveBeenCalledTimes(1);
		expect(loadImages.mock.calls[0][0]).toMatchObject({ message_id: 1 });
		// ...and attached to the owner's line so the model actually sees the image,
		// not just the bare `<photo>` reply-label it used to hallucinate from.
		const ctx = await controller.buildContextForActive();
		const withImage = ctx?.find((message) => message.images?.length);
		expect(withImage?.images).toEqual([
			{ data: "PICDATA", mimeType: "image/jpeg" },
		]);
		expect(withImage?.content).toContain("[replied image]");
	});

	it("fetches no owner media when the owner is not addressing the bot", async () => {
		const { controller, deps } = await setup(["квен"]);
		const loadImages = vi.fn(async () => [
			{ data: "PICDATA", mimeType: "image/jpeg" },
		]);
		deps.loadImages = loadImages;
		const photo = {
			message_id: 1,
			date: 0,
			chat: { id: 42, type: "private", first_name: "Alice" },
			from: { id: 5, is_bot: false, first_name: "Alice" },
			photo: [{ file_id: "PIC", file_size: 100 }],
		} as Message;
		// A plain owner reply with no wake-word opens no turn: nothing is downloaded.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: {
				...ownerMsg("ага, понятно", 100),
				reply_to_message: photo,
			} as Message,
		});
		expect(loadImages).not.toHaveBeenCalled();
	});

	// Manager mode's half of the two-minute stall. A run cannot take a prompt while it
	// is still ending, and `agent_end` is awaited from inside it — so `isIdle()` is
	// false on every path that reaches `triggerTurn` from there. It used to be true (the
	// host lowered its busy flag one event too early), the prompt was forced on a session
	// that could not take it, and the hand-off sat waiting on a promise that only its own
	// return could resolve: two minutes of "Working…", once per chained turn.
	it("hands nothing to a run that is still ending: the held draft waits for the settle pump", async () => {
		const { controller, sendReply, triggerAgent, clock, setIdle } =
			await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("are you there?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);

		// The turn runs, and ends in prose with no tool call. The draft is held — and
		// that is all: no second prompt is pushed at a session that is still on the stack.
		setIdle(false);
		await controller.onAgentEnd("Yes, I am here.");
		expect(sendReply).not.toHaveBeenCalled();
		expect(controller.isReviseTurn()).toBe(true);
		expect(triggerAgent).toHaveBeenCalledTimes(1);

		// The run settles; the host asks again. The revise turn goes out now, at once.
		setIdle(true);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(2);
		expect(triggerAgent.mock.calls[1][0]).toContain("manager_resolve_draft");
	});

	// Same in mixed mode, where `isIdle` also carries the polarity: the owner's coding
	// run settling must not wake the moderator on the shared brain. The pump asks after
	// EVERY run — including the owner's — so this is the guard that keeps it out.
	it("mixed/coding: the settle pump hands nothing over while the owner holds the brain", async () => {
		const { controller, triggerAgent, clock, setIdle } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello", 5, 1),
		});
		clock.advance(300_001);
		// Coding polarity: the manager reports busy however idle the session itself is.
		setIdle(false);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
		// The return timer flips the brain back to Telegram, and the chat is served.
		setIdle(true);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});

	it("mixed/coding priority: a wake-word is held while the brain is busy, served once idle", async () => {
		// In mixed mode's coding polarity the manager's isIdle is false, so a
		// wake-word may make the chat ready but must NOT preempt the owner's coding —
		// unlike the standalone manager, it waits for the return-timer to free the brain.
		const { controller, triggerAgent, setIdle } = await setup(["llm"]);
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
		const { controller } = await setup(["llm"]);
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
		const { controller, triggerAgent } = await setup(["llm"]);
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

	it("never opens a turn on the owner's own question to the interlocutor", async () => {
		// The invariant the owner hit live: they wrote "did you buy bread?" to the
		// interlocutor and the BOT answered "yes" — reading the owner's question as one
		// put to it. No owner message (bar a wake-word) may start a turn at all: after
		// one, nothing in the chat is unanswered, so there is nothing to wake for.
		const { controller, triggerAgent, clock } = await setup(["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("did you buy bread?"),
		});
		expect(controller.status().activeChat).toBeUndefined();
		clock.advance(300_001);
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
		const { controller, triggerAgent, deps } = await setup();
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
		const { controller, triggerAgent } = await setup();
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

	it("the owner writing does not switch the bot off in that chat", async () => {
		// There used to be a freeze: once the owner wrote, nothing the interlocutor said
		// afterwards could reach the bot — not even a wake-word. Now the owner simply
		// took that batch; being addressed still reaches the bot at once.
		const { controller, triggerAgent } = await setup(["llm"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("I've got this one"),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hey llm, what do you think?", 5, 2),
		});
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});

	it("re-engages on the next interlocutor message the owner lets hang", async () => {
		const { controller, triggerAgent, clock } = await setup();
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
		// First message = the standing rules, and NOTHING that varies.
		expect(ctx?.[0].content).toContain("[SYSTEM_INSTRUCTIONS]");
		expect(ctx?.[0].content).toContain("BASE MANAGER RULES");
		expect(ctx?.[0].content).not.toContain("FIRST CONTACT");
		// The first-contact opener is a situational instruction, so it travels with the
		// other situational ones, at the end.
		expect(ctx?.at(-1)?.content).toContain("FIRST CONTACT");
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
		// The speaker is the prefix; the message they answered hangs below, marked as
		// context — never as `Owner: "the blue one?"`, which reads as Owner speaking.
		expect(interlocutor?.content).toContain(
			"Interlocutor (Alice): yes, that one",
		);
		expect(interlocutor?.content).toContain(
			'↳ [answering an earlier message by Owner, which said: "the blue one?"]',
		);
		expect(interlocutor?.content).not.toContain('Owner]: "');
	});

	it("loads the IMAGE of a message an interlocutor REPLIED to, for vision", async () => {
		const { controller, deps, clock } = await setup();
		const loadImages = vi.fn(async (m: { photo?: unknown }) =>
			m.photo ? [{ data: "REPLIED64", mimeType: "image/jpeg" }] : [],
		);
		deps.loadImages = loadImages as never;
		deps.maxImages = 4;
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				message_id: 3,
				date: 0,
				chat: { id: 42, type: "private", first_name: "Alice" },
				from: { id: 5, is_bot: false, first_name: "Alice" },
				text: "what's on this?",
				reply_to_message: {
					message_id: 2,
					date: 0,
					chat: { id: 42, type: "private", first_name: "Alice" },
					from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
					photo: [{ file_id: "P1", file_unique_id: "U1" }],
				},
			} as Message,
		});
		clock.advance(300_001);
		await controller.onTick();
		const ctx = await controller.buildContextForActive();
		const interlocutor = ctx?.find((m) =>
			m.content.includes("what's on this?"),
		);
		expect(interlocutor?.content).toContain("[replied image]");
		// The replied-to picture rides inline on the freshest turn for vision.
		expect((interlocutor as { images?: unknown[] })?.images).toEqual([
			{ data: "REPLIED64", mimeType: "image/jpeg" },
		]);
		expect(loadImages).toHaveBeenCalled();
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
		// Facts live in the trailing message. They are the most volatile thing the model
		// reads — learning ONE of them used to change the head block and cost a full
		// re-read of the conversation underneath it (measured: 19,397 characters).
		expect(ctx?.at(-1)?.content).toContain("Known facts about Alice");
		expect(ctx?.at(-1)?.content).toContain("likes green tea");
		expect(ctx?.[0].content).not.toContain("Known facts about Alice");
		// The clock lives there too, not in the cacheable prefix block.
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
			(await controller.buildContextForActive())?.at(-1)?.content ?? "";
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
		).toContain("Step 1 of 4");
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		await controller.onAgentEnd();

		// Probe 2 — candidates. Owner-tagged / non-durable ones are dropped by code.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 3 of 4");
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
		).toContain("Step 4 of 4");
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
		).toContain("Step 1 of 4");
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		expect(await controller.stepConsolidation()).toBe("continue");

		// candidates → step.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 3 of 4");
		controller.probeSink().record({
			tool: "candidates",
			items: [
				{ text: "ordered a laptop", subject: "interlocutor", durable: true },
			],
		});
		expect(await controller.stepConsolidation()).toBe("continue");

		// verify → step reaches done: the run STOPS here. The model is not sampled once
		// more just to say it has nothing left to do — that call read nothing anybody
		// used, and it re-read the whole prompt (the tool gate takes the probes away when
		// the pass is done, and the tools sit at the head of the prompt, which is the
		// prefix the backend caches).
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("Step 4 of 4");
		controller.probeSink().record({
			tool: "verify",
			keep: true,
			evidenceQuote: "ordered a laptop",
		});
		expect(await controller.stepConsolidation()).toBe("abort");
		expect(controller.isConsolidationDone()).toBe(true);
		// The "you are finished" directive stays as the backstop for the path that can
		// still reach a done pass with the run alive (a queued message defers the step
		// above). Nothing reaches it on the ordinary path any more.
		expect(
			(await controller.buildContextForActive())?.at(-1)?.content,
		).toContain("memory pass for this contact is finished");

		// The whole interrogation ran WITHOUT re-triggering an agent per probe.
		expect(triggerAgent.mock.calls.length).toBe(triggersAtStart);

		// The aborted run ends → agent_end persists the verified fact and closes the pass.
		await controller.onAgentEnd();
		expect((await deps.contactStore.getFacts("5")).map((f) => f.text)).toEqual([
			"ordered a laptop",
		]);
		expect(controller.isConsolidating()).toBe(false);
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
		expect(await controller.stepConsolidation()).toBe("abort");
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
		).toContain("Step 3 of 4");
	});

	it("writes a fact the moment it is verified, not when the pass finishes", async () => {
		// The owner's report: "I thought it had already saved fact, fact, fact — and if you
		// interrupt it, it starts over." It did. A confirmed fact was held in memory until
		// the whole interrogation finished, so anything that ended a pass early — a live
		// message pre-empting it, an abort, a restart — dropped every fact it had already
		// verified, and the next pass asked the same questions from step one.
		const { controller, deps, clock } = await setup();
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
		await controller.onTick(); // starts the interrogation

		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		await controller.stepConsolidation();
		controller.probeSink().record({
			tool: "candidates",
			items: [
				{ text: "ordered a laptop", subject: "interlocutor", durable: true },
				{
					text: "works from an office",
					subject: "interlocutor",
					durable: true,
				},
			],
		});
		await controller.stepConsolidation();

		// One fact verified. It is on disk NOW — the pass has not finished, and the second
		// fact has not even been asked about yet.
		controller.probeSink().record({
			tool: "verify",
			keep: true,
			evidenceQuote: "ordered a laptop",
		});
		await controller.stepConsolidation();
		expect((await deps.contactStore.getFacts("5")).map((f) => f.text)).toEqual([
			"ordered a laptop",
		]);

		// The pass is now interrupted for good (the process could die here). What was
		// verified survives; only the unasked candidate is lost, and it is cheap to redo.
		await controller.onAgentEnd();
		expect((await deps.contactStore.getFacts("5")).map((f) => f.text)).toEqual([
			"ordered a laptop",
		]);
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

	it("rehydrates a contact's userId from the transcript so facts persist after a restart", async () => {
		const { controller, deps } = await setup();
		// A transcript already exists on disk from a prior session (senderId recorded),
		// and the contact record exists — but the in-memory chats map is empty (as it
		// is right after a restart, before any fresh live message).
		await deps.contactStore.upsertProfile(
			{ userId: "5", displayName: "Alice" },
			0,
		);
		await deps.chatStore.append("42", {
			author: "interlocutor",
			text: "I live in Almaty",
			timestamp: 0,
			senderId: "5",
			senderName: "Alice",
			messageId: 1,
		});
		// Catch-up marks the chat ready WITHOUT a userId (the gap this fixes).
		controller.markReady("42", { connectionId: CONN, contactName: "Alice" });
		// Building the turn context rehydrates the userId from the transcript.
		await controller.buildContextForActive();
		// A durable fact recorded this turn must land under userId "5".
		controller
			.factSink()
			.record([
				{ text: "lives in Almaty", subject: "interlocutor", kind: "identity" },
			]);
		controller.decisionSink().record({ kind: "reply", text: "noted" });
		await controller.onAgentEnd();
		expect(
			(await deps.contactStore.getFacts("5")).map((f) => f.text),
		).toContain("lives in Almaty");
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
		const { controller, triggerAgent, clock, setIdle } = await setup(["llm"]);
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

	it("unlearns a remembered fact the person themselves overturned", async () => {
		// Memory that only ever grows eventually lies. A fact was true when it was learned
		// and can stop being true — and until now nothing could remove one but a schema
		// migration wiping every contact at once. So the bot would go on telling people,
		// with total confidence, something they had corrected to its face weeks earlier.
		const { controller, deps, clock } = await setup();
		await deps.contactStore.upsertProfile(
			{ userId: "5", displayName: "Alice" },
			0,
		);
		await deps.contactStore.addFact("5", {
			text: "Works at a bank",
			timestamp: 0,
			kind: "identity",
		});

		// They say the thing that overturns it, and the conversation ends.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("i left the bank last month, freelancing now"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller
			.decisionSink()
			.record({ kind: "silent", reason: "nothing asked" });
		await controller.onAgentEnd();

		// The idle memory pass reviews what it holds against what was said.
		clock.advance(1_800_001);
		await controller.onTick();
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		await controller.stepConsolidation();

		// Step 2 asks about the fact it already holds, by number.
		const review = (await controller.buildContextForActive())?.at(-1)?.content;
		expect(review).toContain("1. Works at a bank");
		controller.probeSink().record({
			tool: "forget",
			items: [{ number: 1, evidenceQuote: "i left the bank last month" }],
		});
		await controller.stepConsolidation();

		// It is gone from the store the moment the step is taken — not held in memory until
		// the pass finishes, where a pre-empt or a restart would lose it.
		expect(await deps.contactStore.getFacts("5")).toEqual([]);
	});

	it("writes down a decision to stay silent, which the transcript cannot hold", async () => {
		// A reply is a message and lands in the transcript. Silence is not, and does not —
		// so the chat went on looking, to every later launch, exactly like someone whose
		// message nobody had answered, and catch-up went and answered it. Days-old banter,
		// replied to on every restart. The turn settled; the cursor says so.
		const { controller, deps, sendReply, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("😂😂😂"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "silent", reason: "just banter" });
		await controller.onAgentEnd();

		expect(sendReply).not.toHaveBeenCalled();
		const records = await deps.chatStore.getRecent("42", 20);
		// The transcript still ends on them — it has no way to say we read it and passed.
		expect(records.at(-1)?.author).toBe("interlocutor");
		const cursor = await deps.chatCursors.get("42");
		expect(cursor?.handledThrough).toBe(records.at(-1)?.timestamp);
	});

	// The bug this whole cursor exists for. Activation seeds every stored transcript back
	// into the queue — that is what makes memory survive a restart at all — stamped with
	// its real last-activity time. For a conversation that ended yesterday that stamp is
	// far past the quiet threshold, so the chat is eligible AT ONCE. With nothing on disk
	// saying what had already been read, the entire interrogation ran again, on the same
	// messages, at every single launch: the owner watched one contact be interrogated six
	// or seven times over. The facts were deduplicated on write, so nothing was corrupted
	// — it just burned a full pass of inference per chat, forever.
	it("does not interrogate a chat again over messages a pass has already read", async () => {
		const { controller, deps, triggerAgent, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("i just ordered a laptop for work"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Noted!" });
		await controller.onAgentEnd();

		// An idle gap → the memory pass runs, start to finish.
		clock.advance(1_800_001);
		await controller.onTick();
		controller.probeSink().record({
			tool: "identify",
			sameAsOwner: false,
			interlocutorName: "Alice",
		});
		await controller.stepConsolidation();
		controller.probeSink().record({
			tool: "candidates",
			items: [
				{ text: "ordered a laptop", subject: "interlocutor", durable: true },
			],
		});
		await controller.stepConsolidation();
		controller.probeSink().record({
			tool: "verify",
			keep: true,
			evidenceQuote: "ordered a laptop",
		});
		await controller.stepConsolidation();
		await controller.onAgentEnd(); // the pass finalizes
		expect(await deps.consolidationQueue.all()).toHaveLength(0);
		const passes = countConsolidation(triggerAgent.mock.calls);
		expect(passes).toBe(1);

		// Now a restart: the transcript on disk is seeded back exactly as activation does
		// it, with the time of its newest message. Nothing has been said since, so there
		// is nothing here to read — and the chat does not even enter the queue.
		const records = await deps.chatStore.getRecent("42", 20);
		const lastActivity = records[records.length - 1].timestamp;
		await controller.seedConsolidation(
			"42",
			{ connectionId: CONN, contactName: "Alice", userId: "5" },
			lastActivity,
		);
		expect(await deps.consolidationQueue.all()).toHaveLength(0);
		clock.advance(1_800_001);
		await controller.onTick();
		expect(countConsolidation(triggerAgent.mock.calls)).toBe(passes);

		// New words, though, are new material — and those it must go and read.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				...interlocutorMsg("and a second monitor", 5, 7),
				date: Math.floor(clock.now() / 1000),
			},
		});
		expect(await deps.consolidationQueue.all()).toHaveLength(1);
	});

	it("queues a chat known only from disk, so a restart does not lose its memory", async () => {
		// The queue used to be fed by live traffic alone: a conversation that ended
		// before this process started was never consolidated at all. Activation seeds
		// it from the transcripts on disk instead.
		const { controller, triggerAgent, deps, clock } = await setup();
		await controller.seedConsolidation(
			"chat-1",
			{ connectionId: "conn", contactName: "Ada", userId: "77" },
			clock.now(),
		);
		expect(await deps.consolidationQueue.all()).toEqual([
			{ chatId: "chat-1", userId: "77", activityAt: clock.now() },
		]);

		clock.advance(1_800_001); // quiet long enough
		await controller.onTick();
		expect(countConsolidation(triggerAgent.mock.calls)).toBe(1);
	});
});

/** A message the interlocutor FORWARDED into the chat (pasted-in content). */
function forwardedMsg(text: string, messageId: number): Message {
	return {
		...interlocutorMsg(text, 5, messageId),
		forward_origin: {
			type: "hidden_user",
			date: 0,
			sender_user_name: "Somebody",
		},
	} as Message;
}

describe("ManagerController forward budget", () => {
	async function forwardSetup() {
		const base = await setup();
		// A tighter budget than the default, so the test says what it means.
		const controller = new ManagerController({
			...base.deps,
			forwards: { maxChars: 10, maxMessages: 2, groupWindowMs: 3000 },
		});
		return { ...base, controller };
	}

	it("caps the body of one forwarded message", async () => {
		const { controller, deps } = await forwardSetup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: forwardedMsg("0123456789abcdef", 1),
		});
		const [record] = await deps.chatStore.getRecent("42", 10);
		expect(record.text).toContain("0123456789…[+6 chars not read]");
	});

	it("stops reading a forward batch past the limit, keeping one note", async () => {
		// A stranger pasting twenty posts must not be able to fill a small context.
		const { controller, deps } = await forwardSetup();
		for (let i = 1; i <= 5; i += 1) {
			await controller.onBusinessMessage({
				connectionId: CONN,
				chatId: "42",
				fromId: 5,
				message: forwardedMsg(`post ${i}`, i),
			});
		}
		const records = await deps.chatStore.getRecent("42", 10);
		// Two read, one note, and nothing else stored.
		expect(records).toHaveLength(3);
		expect(records[0].text).toContain("post 1");
		expect(records[1].text).toContain("post 2");
		expect(records[2].text).toContain("forward limit");
		expect(records.some((r) => r.text.includes("post 4"))).toBe(false);
	});

	it("leaves an ordinary message alone, and it reopens the batch", async () => {
		const { controller, deps } = await forwardSetup();
		for (let i = 1; i <= 3; i += 1) {
			await controller.onBusinessMessage({
				connectionId: CONN,
				chatId: "42",
				fromId: 5,
				message: forwardedMsg(`post ${i}`, i),
			});
		}
		// They go back to talking: the batch is over, and a long message they WROTE is
		// not touched by the forward budget.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("what do you think of all that?", 5, 4),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: forwardedMsg("one more", 5),
		});
		const records = await deps.chatStore.getRecent("42", 10);
		const texts = records.map((r) => r.text);
		expect(
			texts.some((t) => t.includes("what do you think of all that?")),
		).toBe(true);
		// A fresh batch: the next forward is read again rather than refused.
		expect(texts.some((t) => t.includes("one more"))).toBe(true);
	});
});

describe("ManagerController owner identity without a stored connection", () => {
	/** The manager, with an EMPTY business store — the state a bot connected before
	 * its first run is in: Telegram only sends `business_connection` on change. */
	async function noConnectionSetup() {
		const base = await setup();
		const fs = new FakeFs();
		const paths = createTelegramPaths("/agent-2");
		const controller = new ManagerController({
			...base.deps,
			businessStore: createBusinessStore(fs, paths.businessPath),
			ownerUserId: String(OWNER_ID),
		});
		return { ...base, controller };
	}

	it("still knows the owner's own message is not an interlocutor's", async () => {
		// Regression: with no stored connection the owner id was undefined, so every
		// owner message — including the bot's own echo — was classified as the
		// interlocutor's, and the manager would answer the owner.
		const { controller, triggerAgent, clock } = await noConnectionSetup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("I will handle this one myself"),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
		expect(controller.status().activeChat).toBeUndefined();
	});

	it("still stands the bot down while the owner is answering", async () => {
		const { controller, triggerAgent, clock } = await noConnectionSetup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("are you there?"),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("yes, one sec"),
		});
		// The owner answered: that batch is theirs, and the bot never steps on it.
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
	});

	it("still treats an interlocutor message as the job", async () => {
		const { controller, triggerAgent, clock } = await noConnectionSetup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello?"),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});
});

describe("ManagerController — whose words are whose", () => {
	// The bug this pins down: a reply carries the text of the message it answers.
	// That quoted text used to be stored INSIDE the replier's own line, so the model
	// read the person being answered as the one speaking, and the memory pass took
	// the owner's quoted words as proof of a fact about the contact.
	const replyToOwner = (text: string): Message =>
		({
			message_id: 3,
			date: 0,
			chat: { id: 42, type: "private", first_name: "Alice" },
			from: { id: 5, is_bot: false, first_name: "Alice" },
			text,
			reply_to_message: {
				message_id: 2,
				date: 0,
				chat: { id: 42, type: "private", first_name: "Alice" },
				from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
				text: "my name is Alex and I run a bakery",
			},
		}) as Message;

	it("keeps the quoted message out of the replier's own words", async () => {
		const { controller, deps } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: replyToOwner("nice"),
		});
		const [record] = await deps.chatStore.all("42");
		expect(record.text).toBe("nice");
		expect(record.text).not.toContain("bakery");
		expect(record.context).toContain("bakery");
		// The evidence a fact about Alice may rest on is "nice" — nothing else. Before
		// the fix, "Alex" and "bakery" sat in her line and confirmed facts about HER.
		expect(ownWords(record)).toBe("nice");
	});

	it("marks a forwarded body as somebody else's words", async () => {
		const { controller, deps } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: {
				message_id: 4,
				date: 0,
				chat: { id: 42, type: "private", first_name: "Alice" },
				from: { id: 5, is_bot: false, first_name: "Alice" },
				text: "I am a doctor in Berlin",
				forward_origin: {
					type: "user",
					date: 0,
					sender_user: { id: 77, is_bot: false, first_name: "Bob" },
				},
			} as Message,
		});
		const [record] = await deps.chatStore.all("42");
		expect(record.forwarded).toBe(true);
		// Alice passed Bob's message along; she never claimed to be a doctor.
		expect(ownWords(record)).toBe("");
	});

	it("shows the owner's reply as the OWNER speaking, with the quote below it", async () => {
		const { controller, deps } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("here you go"),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: {
				message_id: 101,
				date: 0,
				chat: { id: 42, type: "private", first_name: "Alice" },
				from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
				text: "did you get the signatures?",
				reply_to_message: {
					message_id: 1,
					date: 0,
					chat: { id: 42, type: "private", first_name: "Alice" },
					from: { id: 5, is_bot: false, first_name: "Alice" },
					text: "<photo>",
				},
			} as Message,
		});
		const records = await deps.chatStore.all("42");
		const owner = records.find((r) => r.author === "owner");
		expect(owner?.text).toBe("did you get the signatures?");
		const messages = buildIsolatedMessages({ records });
		const line = messages.find((m) =>
			m.content.includes("did you get the signatures?"),
		);
		// The question is the OWNER's. Alice's name appears only in the context line.
		expect(line?.content).toContain("Owner: did you get the signatures?");
		expect(line?.content).toContain("↳ [answering an earlier message by Alice");
		expect(line?.content).not.toContain('Alice]: "');
	});
});

describe("ManagerController — the owner summons the bot (observer)", () => {
	const forwardMsg = (text: string, messageId: number): Message =>
		({
			message_id: messageId,
			date: 0,
			chat: { id: 42, type: "private", first_name: "Alice" },
			from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
			text,
			forward_origin: {
				type: "channel",
				date: 0,
				chat: { id: -100, type: "channel", title: "News" },
				message_id: 7,
			},
		}) as Message;

	it("keeps the summons alive while the owner is still adding to their question", async () => {
		const { controller, triggerAgent } = await setup(["qwen"]);
		// The owner asks the bot something...
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("hey qwen, which messages did I forward?", 100),
		});
		// ...and a second later pastes in the material the question is about. The tick
		// that starts the turn has not run yet: these follow-ups used to clear the
		// chat's pending work, so the question was silently dropped.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: forwardMsg("a long forwarded post", 101),
		});
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
		expect(controller.status().activeChat).toBe("42");
	});

	it("still stands down when the owner just answers the chat themselves", async () => {
		const { controller, triggerAgent, clock } = await setup(["qwen"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("are you coming?"),
		});
		// No wake-word: the owner handled it, so the bot must not step in.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("yes, on my way", 100),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).not.toHaveBeenCalled();
	});

	it("forgets the summons once the turn has run", async () => {
		const { controller, triggerAgent, clock } = await setup(["qwen"]);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("qwen, summarise this chat", 100),
		});
		await controller.onTick();
		controller.decisionSink().record({ kind: "silent", reason: "done" });
		await controller.onAgentEnd();
		expect(triggerAgent).toHaveBeenCalledTimes(1);

		// A later owner message is an ordinary one again — it stands the bot down.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("still there?", 5, 2),
		});
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("yes, sorry", 101),
		});
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1);
	});
});

describe("ManagerController — the owner steps into a live chat", () => {
	it("ends the 1:30 fast lane, so the next message waits for the owner again", async () => {
		// The continuation window exists for a conversation the bot is carrying: while
		// it is armed the interlocutor's next message skips the owner-reply window. That
		// is right only while the exchange is bot↔interlocutor. Once the owner writes,
		// they are present — and the bot must let them answer first again, or it replies
		// straight over the owner who just arrived.
		const { controller, triggerAgent, sendReply, clock } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("what time?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "at six" });
		await controller.onAgentEnd();
		expect(sendReply).toHaveBeenCalledTimes(1);

		// The owner drops a line into the chat, inside the 1:30 window.
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("actually, make it seven", 100),
		});
		// The interlocutor answers 20 seconds later — still inside what WAS the fast
		// lane. The bot must not jump in: the owner is right there.
		clock.advance(20_000);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("seven works?", 5, 2),
		});
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(1); // still just the first turn

		// It is not lost — it goes through the full owner-reply window like any other.
		clock.advance(300_001);
		await controller.onTick();
		expect(triggerAgent).toHaveBeenCalledTimes(2);
	});

	it("holds the draft when the owner answers mid-turn instead of sending it blind", async () => {
		// The owner answering while the model is generating used to change nothing: the
		// reply went out anyway, straight over them. Now the draft is held and the model
		// gets a revise turn to send / refine / drop it against what the owner said.
		const { controller, sendReply, triggerAgent, setIdle, clock } =
			await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("what's the price?", 5, 1),
		});
		clock.advance(300_001);
		await controller.onTick();
		const triggersAfterStart = triggerAgent.mock.calls.length;

		// The owner answers while the model is still writing.
		setIdle(false);
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: OWNER_ID,
			message: ownerMsg("it's 200", 100),
		});

		setIdle(true);
		controller
			.decisionSink()
			.record({ kind: "reply", text: "the price is 200" });
		await controller.onAgentEnd();

		// Nothing sent; a revise turn runs instead, naming the resolve tool.
		expect(sendReply).not.toHaveBeenCalled();
		expect(triggerAgent.mock.calls.length).toBe(triggersAfterStart + 1);
		const ctx = await controller.buildContextForActive();
		expect(ctx?.at(-1)?.content).toContain("manager_resolve_draft");
		expect(ctx?.at(-1)?.content).toContain("the price is 200");

		// The model sees the owner already answered and drops it.
		controller.resolveSink().record({ action: "drop" });
		await controller.onAgentEnd();
		expect(sendReply).not.toHaveBeenCalled();
	});
});

describe("a memory pass is not a conversation", () => {
	/** Run a chat up to the point where its idle consolidation pass starts. */
	async function untilConsolidating() {
		const env = await setup();
		const { controller, clock } = env;
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("are you around?"),
		});
		clock.advance(300_001);
		await controller.onTick();
		controller.decisionSink().record({ kind: "reply", text: "Yes." });
		await controller.onAgentEnd();
		// Past the continuation window and the quiet period → the memory pass begins.
		clock.advance(1_800_001);
		await controller.onTick();
		expect(controller.isConsolidating()).toBe(true);
		return env;
	}

	it("ends the pass with words about a memory pass, not about a decision", async () => {
		// The bug: the pass was ended with the reply-turn directive ("you have already
		// decided this turn"). A model reading that, mid-memory-review, decided it had
		// answered somebody — and wrote a word of prose for a chat it was never in.
		const { controller } = await untilConsolidating();
		controller
			.probeSink()
			.record({ tool: "identify", sameAsOwner: false, interlocutorName: "A" });
		await controller.onAgentEnd();
		controller.probeSink().record({ tool: "candidates", items: [] });
		expect(controller.turnDecided()).toBe(false);
		await controller.stepConsolidation();

		// Nothing to verify → the pass is finished, and the directive says so in its own
		// terms: a memory pass, nobody to answer, no tool to call.
		const directive =
			(await controller.buildContextForActive())?.at(-1)?.content ?? "";
		expect(directive).toContain("memory pass");
		expect(directive).toContain("not replying to anyone");
		expect(directive).not.toContain("already decided this turn");
	});

	it("leaves no decision behind for the next person's turn", async () => {
		// Belt and braces for the same bug: the reply tools are gone from a memory pass
		// now, but a decision sink that outlives the turn that filled it is a landmine —
		// and the next turn to read it belongs to somebody else.
		const { controller } = await untilConsolidating();
		controller.decisionSink().record({ kind: "silent" });
		controller
			.probeSink()
			.record({ tool: "identify", sameAsOwner: false, interlocutorName: "A" });
		await controller.onAgentEnd();
		controller.probeSink().record({ tool: "candidates", items: [] });
		await controller.onAgentEnd();

		expect(controller.isConsolidating()).toBe(false);
		expect(controller.decisionSink().current().kind).toBe("none");
	});
});
