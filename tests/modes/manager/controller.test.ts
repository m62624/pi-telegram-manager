import type { BusinessConnection, Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import {
	ManagerController,
	type ManagerControllerDeps,
} from "../../../src/modes/manager/controller";
import { hasBotMarker } from "../../../src/modes/manager/identity";
import { createBusinessStore } from "../../../src/storage/business-store";
import { createChatStore } from "../../../src/storage/chat-store";
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

async function setup(subMode: ManagerSubMode = "observer") {
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
	const sendReply = vi.fn(async () => nextId++);
	let idle = true;
	const deps: ManagerControllerDeps = {
		subMode,
		instructions: { base: "BASE MANAGER RULES", firstMessage: "FIRST CONTACT" },
		labeler: "LLM agent:",
		rememberMessages: 20,
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		clock,
		chatStore: createChatStore(fs, paths),
		contactStore: createContactStore(fs, paths),
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
	it("makes the first interlocutor chat active and triggers a turn", async () => {
		const { controller, triggerAgent, typing } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hello"),
		});
		expect(triggerAgent).toHaveBeenCalledTimes(1);
		expect(typing).toHaveBeenCalledWith({ connectionId: CONN, chatId: "42" });
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 0 });
	});

	it("delivers manager_reply text on turn end, labelled + bot-tagged + recorded", async () => {
		const { controller, sendReply, deps } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi"),
		});
		controller.decisionSink().record({ kind: "reply", text: "Hello there!" });
		await controller.onAgentEnd();

		expect(sendReply).toHaveBeenCalledTimes(1);
		const sent = sendReply.mock.calls[0][0];
		expect(sent.text).toContain("LLM agent:");
		expect(sent.text).toContain("Hello there!");
		expect(hasBotMarker(sent.text)).toBe(true);
		// recorded as bot-sent so it won't be mistaken for the owner later
		expect(await deps.sentRegistry.wasSentByBot("42", 500)).toBe(true);
		const stored = await deps.chatStore.all("42");
		expect(stored.at(-1)).toMatchObject({
			author: "bot",
			text: "Hello there!",
		});
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

	it("builds an isolated context for the active chat only", async () => {
		const { controller } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("hi there"),
		});
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
			ctx?.some((m) => m.content === "Interlocutor (Alice): hi there"),
		).toBe(true);
		// The turn ends with the action directive that forces a tool call.
		expect(ctx?.at(-1)?.content).toContain("manager_reply");
	});

	it("carries reply/forward context of an interlocutor message into the context", async () => {
		const { controller } = await setup();
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
		const ctx = await controller.buildContextForActive();
		const interlocutor = ctx?.find((m) => m.content.includes("yes, that one"));
		expect(interlocutor?.content).toContain(
			'[reply to Owner]: "the blue one?"',
		);
	});

	it("queues a second chat while the first is active", async () => {
		const { controller, triggerAgent, setIdle } = await setup();
		await controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("first"),
		});
		setIdle(false); // agent now busy on chat 42
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
		expect(triggerAgent).toHaveBeenCalledTimes(1); // only the first
		expect(controller.status()).toMatchObject({ activeChat: "42", queued: 1 });
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
