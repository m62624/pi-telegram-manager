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
			"telegram_bot_about",
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
			// The tool list is applied HERE, not at before_provider_request: a run
			// snapshots its tools before the first request, so a refresh at request time
			// lands one call too late and the model opens the turn with the previous
			// turn's tools. See `pi/tool-visibility.ts`.
			"before_agent_start",
			"agent_start",
			"turn_end",
			"agent_end",
			// Not the same moment as agent_end, and the difference was two minutes: the
			// end fires from INSIDE the run (Pi awaits the handler), the settle fires
			// once the run is really over. Every prompt hand-off waits for this one.
			"agent_settled",
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
