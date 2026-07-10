import { describe, expect, it, vi } from "vitest";
import piTelegramManagerExtension from "../src/index";

/** Minimal fake ExtensionAPI capturing what the composition root registers. */
function fakePi() {
	const commands = new Map<string, unknown>();
	const tools: { name: string }[] = [];
	const events = new Map<string, unknown>();
	const api = {
		registerCommand: vi.fn((name: string, options: unknown) =>
			commands.set(name, options),
		),
		registerTool: vi.fn((tool: { name: string }) => tools.push(tool)),
		on: vi.fn((event: string, handler: unknown) => events.set(event, handler)),
		getAllTools: vi.fn(() => tools.map((t) => ({ name: t.name }))),
		setActiveTools: vi.fn(),
		sendUserMessage: vi.fn(async () => {}),
	};
	return { api, commands, tools, events };
}

describe("piTelegramManagerExtension (composition root)", () => {
	it("loads without throwing and registers commands, tools, and handlers", () => {
		const { api, commands, tools, events } = fakePi();

		// biome-ignore lint/suspicious/noExplicitAny: fake is a structural subset of ExtensionAPI
		expect(() => piTelegramManagerExtension(api as any)).not.toThrow();

		for (const command of [
			"telegram-connect",
			"telegram-disconnect",
			"telegram-status",
			"telegram-manager",
			"telegram-manager-stop",
		]) {
			expect(commands.has(command)).toBe(true);
		}
		expect(tools.map((t) => t.name)).toEqual([
			"telegram_message",
			"telegram_attach",
		]);
		for (const event of [
			"session_start",
			"before_provider_request",
			"agent_start",
			"agent_end",
			"session_shutdown",
		]) {
			expect(events.has(event)).toBe(true);
		}
	});

	it("does not touch tool visibility action methods during load", () => {
		const { api } = fakePi();
		// biome-ignore lint/suspicious/noExplicitAny: fake is a structural subset of ExtensionAPI
		piTelegramManagerExtension(api as any);
		expect(api.getAllTools).not.toHaveBeenCalled();
		expect(api.setActiveTools).not.toHaveBeenCalled();
	});
});
