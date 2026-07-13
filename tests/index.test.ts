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
			"telegram-personal",
			"telegram-manager",
			"telegram-mixed",
			"telegram-stop",
			"telegram-status",
		]) {
			expect(commands.has(command)).toBe(true);
		}
		// The terminal switcher is gone: the four mode commands above ARE the switcher,
		// and /switch in Telegram covers the phone.
		expect(commands.has("telegram-switch")).toBe(false);
		expect(tools.map((t) => t.name)).toEqual([
			// Registered first, and available in every mode: it is how the model answers
			// "what are you?" from the project's own pages instead of improvising.
			"about",
			"telegram_attach",
			"manager_reply",
			"manager_silent",
			"manager_remember",
			"manager_skip",
			"manager_identify",
			"manager_candidates",
			"manager_verify",
			"manager_resolve_draft",
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
