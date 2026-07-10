import type { Update } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { AbortRegistry } from "../../../src/core/abort";
import {
	ConnectController,
	type ConnectControllerDeps,
} from "../../../src/modes/connect/controller";
import { OutboundSender } from "../../../src/telegram/outbound";
import {
	classifyUpdate,
	type TelegramEvent,
} from "../../../src/telegram/updates";
import { FakeOutboundApi } from "../../helpers/fake-outbound-api";

const ALLOWED = 777;

function messageEvent(
	text: string,
	messageId = 1,
	fromId = ALLOWED,
): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		message: {
			message_id: messageId,
			date: 0,
			chat: { id: fromId, type: "private", first_name: "A" },
			from: { id: fromId, is_bot: false, first_name: "Ada" },
			text,
		},
	} as Update);
}

function editedEvent(text: string, messageId: number): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		edited_message: {
			message_id: messageId,
			date: 0,
			edit_date: 1,
			chat: { id: ALLOWED, type: "private", first_name: "A" },
			from: { id: ALLOWED, is_bot: false, first_name: "Ada" },
			text,
		},
	} as Update);
}

function setup(overrides: Partial<ConnectControllerDeps> = {}) {
	const api = new FakeOutboundApi();
	const abort = new AbortRegistry();
	const sendFollowUp = vi.fn(async () => {});
	let idle = true;
	const deps: ConnectControllerDeps = {
		allowedUserId: ALLOWED,
		maxBytes: 1000,
		isIdle: () => idle,
		sendFollowUp,
		outbound: new OutboundSender(api),
		abort,
		...overrides,
	};
	const controller = new ConnectController(deps);
	return {
		controller,
		api,
		abort,
		sendFollowUp,
		setIdle: (v: boolean) => (idle = v),
	};
}

describe("ConnectController", () => {
	it("ignores messages from an unauthorized user", async () => {
		const { controller, sendFollowUp } = setup();
		const handled = await controller.onEvent(messageEvent("hi", 1, 999));
		expect(handled).toBe(false);
		expect(sendFollowUp).not.toHaveBeenCalled();
	});

	it("dispatches an authorized message immediately when idle", async () => {
		const { controller, sendFollowUp } = setup();
		await controller.onEvent(messageEvent("hello"));
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("hello");
		expect(controller.pendingCount()).toBe(0);
	});

	it("queues without dispatching while the agent is busy", async () => {
		const { controller, sendFollowUp, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("later"));
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(1);
	});

	it("pumps the next queued turn and mirrors the reply on agent end", async () => {
		const { controller, api, sendFollowUp, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("first", 1));
		await controller.onEvent(messageEvent("second", 2));
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(2);

		setIdle(true);
		await controller.onAgentEnd([{ role: "assistant", content: "done" }]);

		// reply mirrored to Telegram
		expect(api.sent.at(-1)?.rich_message).toEqual({
			markdown: "done",
			skip_entity_detection: true,
		});
		// and the next queued turn released
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("first");
		expect(controller.pendingCount()).toBe(1);
	});

	it("does not send when the final message is not an assistant reply", async () => {
		const { controller, api } = setup();
		await controller.onAgentEnd([{ role: "user", content: "ignored" }]);
		expect(api.sent).toHaveLength(0);
	});

	it("edits a still-queued turn instead of enqueuing a duplicate", async () => {
		const { controller, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("original", 5));
		await controller.onEvent(editedEvent("edited", 5));
		expect(controller.pendingCount()).toBe(1);
	});

	it("skips a trailing empty assistant message when mirroring the reply", async () => {
		const { controller, api } = setup();
		await controller.onAgentEnd([
			{ role: "assistant", content: "the answer" },
			{ role: "assistant", content: "" },
		]);
		expect(api.sent.at(-1)?.rich_message).toEqual({
			markdown: "the answer",
			skip_entity_detection: true,
		});
	});

	it("delivers a downloaded image as content parts alongside the turn text", async () => {
		const loadImages = vi.fn(async () => [
			{ data: "BASE64", mimeType: "image/jpeg" },
		]);
		const { controller, sendFollowUp } = setup({ loadImages });
		await controller.onEvent(messageEvent("what is this?"));
		expect(loadImages).toHaveBeenCalledTimes(1);
		const content = sendFollowUp.mock.calls[0][0];
		expect(Array.isArray(content)).toBe(true);
		expect(content).toEqual([
			{ type: "image", data: "BASE64", mimeType: "image/jpeg" },
			{ type: "text", text: expect.stringContaining("what is this?") },
		]);
	});

	it("sends plain text (not an array) when there are no images", async () => {
		const { controller, sendFollowUp } = setup({
			loadImages: async () => [],
		});
		await controller.onEvent(messageEvent("just text"));
		expect(typeof sendFollowUp.mock.calls[0][0]).toBe("string");
	});

	it("broadcasts a typing action to the bound chat", async () => {
		const { controller, api } = setup();
		await controller.sendTyping();
		expect(api.actions).toEqual([{ chat_id: ALLOWED, action: "typing" }]);
	});

	it("arms and clears the abort handler around a turn", async () => {
		const { controller, abort } = setup();
		const stop = vi.fn();
		controller.onAgentStart(stop);
		expect(abort.isArmed()).toBe(true);
		await controller.onAgentEnd([]);
		expect(abort.isArmed()).toBe(false);
	});
});
