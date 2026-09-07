import { describe, expect, it, vi } from "vitest";
import { AgentControlController, sanitizeAgentText } from "../../src/telegram/agent-control";
import { AgentCallbackScope, type AgentControlPort } from "../../src/telegram/agent-panel";

const context = {
	sessionId: "session-a",
	sessionLabel: "Main · project-a",
	chatId: 42,
	userId: 42,
};

function fixture() {
	const native: AgentControlPort = {
		listAgents: vi.fn(async () => ({
			items: [{ id: "worker-a", name: "Image worker", status: "running", progress: "Rendering" }],
			nextCursor: "next-page",
		})),
		getAgent: vi.fn(async () => ({
			id: "worker-a",
			name: "Image worker",
			status: "completed",
			result: "Rendered two artifacts",
			media: [
				{ kind: "photo" as const, path: "C:/safe/result.png", caption: "Preview" },
				{ kind: "document" as const, path: "C:/safe/result.json", caption: "Data" },
			],
		})),
	};
	const output = {
		sendMessage: vi.fn(async () => ({ messageId: 7 })),
		editMessage: vi.fn(async () => {}),
		answerCallback: vi.fn(async () => {}),
		sendPhoto: vi.fn(async () => {}),
		sendDocument: vi.fn(async () => {}),
	};
	let sequence = 0;
	const callbacks = new AgentCallbackScope(() => 1_000, () => `t${++sequence}`);
	return { native, output, controller: new AgentControlController(native, output, callbacks) };
}

describe("AgentControlController", () => {
	it("lists only the active native session with bounded pagination", async () => {
		const { native, output, controller } = fixture();
		await expect(controller.handleCommand("/agents", context)).resolves.toBe(true);
		expect(native.listAgents).toHaveBeenCalledWith({
			sessionId: "session-a",
			cursor: undefined,
			limit: 5,
		});
		expect(output.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 42,
				text: expect.stringContaining("Image worker — running"),
			}),
		);
	});

	it("acks a scoped callback, renders details, and uses real photo/document output ports", async () => {
		const { output, controller } = fixture();
		await controller.handleCommand("/agents", context);
		const panel = output.sendMessage.mock.calls[0][0];
		const callback = panel.replyMarkup.inline_keyboard[0][0].callback_data;
		await expect(
			controller.handleCallback(
				{ data: callback, callbackQueryId: "query-a", messageId: 7 },
				context,
			),
		).resolves.toBe(true);
		expect(output.answerCallback).toHaveBeenCalledWith({ callbackQueryId: "query-a" });
		expect(output.editMessage).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("Rendered two artifacts") }),
		);
		expect(output.sendPhoto).toHaveBeenCalledWith({
			chatId: 42,
			path: "C:/safe/result.png",
			caption: "Preview",
		});
		expect(output.sendDocument).toHaveBeenCalledWith({
			chatId: 42,
			path: "C:/safe/result.json",
			caption: "Data",
		});
	});

	it("rejects a cross-chat callback and leaves native control untouched", async () => {
		const { native, output, controller } = fixture();
		await controller.handleCommand("/agents", context);
		const callback = output.sendMessage.mock.calls[0][0].replyMarkup.inline_keyboard[0][0]
			.callback_data;
		await controller.handleCallback(
			{ data: callback, callbackQueryId: "query-b", messageId: 7 },
			{ ...context, chatId: 99 },
		);
		expect(native.getAgent).not.toHaveBeenCalled();
		expect(output.answerCallback).toHaveBeenLastCalledWith({
			callbackQueryId: "query-b",
			text: "This agent view is no longer valid.",
		});
	});

	it("does not capture unrestricted free text", async () => {
		const { controller } = fixture();
		await expect(controller.handleCommand("show me what worker-a found", context)).resolves.toBe(false);
	});

	it("redacts common credential forms before Telegram display", () => {
		expect(sanitizeAgentText("token 123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345")).toBe(
			"token [REDACTED_BOT_TOKEN]",
		);
	});
});
