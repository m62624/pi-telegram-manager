/**
 * pi-telegram-manager — composition root.
 *
 * This is the single Pi extension entrypoint (declared in package.json under
 * `pi.extensions`). It only wires domains together; it holds no domain logic.
 * The real behavior lands across `src/{pi,telegram,storage,core,modes,ui}`.
 *
 * NOTE (Phase 0 scaffold): the mode commands are registered as safe stubs so
 * the extension loads cleanly in Pi. Each phase replaces a stub with its real
 * controller.
 */
import { COMMANDS } from "./constants";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";

export default function piTelegramManagerExtension(pi: ExtensionAPI): void {
	registerPlaceholderCommands(pi);
}

/** Temporary Phase-0 command registration; replaced per phase. */
function registerPlaceholderCommands(pi: ExtensionAPI): void {
	const stub =
		(label: string) =>
		async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.ui.notify(`${label} is not implemented yet (scaffold).`);
		};

	pi.registerCommand(COMMANDS.connect, {
		description: "Bind this terminal session to a Telegram chat (mode 1).",
		handler: stub("/telegram-connect"),
	});
	pi.registerCommand(COMMANDS.disconnect, {
		description: "Disconnect the terminal-continuation bridge (mode 1).",
		handler: stub("/telegram-disconnect"),
	});
	pi.registerCommand(COMMANDS.status, {
		description: "Show the Telegram bridge status.",
		handler: stub("/telegram-status"),
	});
	pi.registerCommand(COMMANDS.manager, {
		description: "Start the Telegram business manager (mode 2).",
		handler: stub("/telegram-manager"),
	});
	pi.registerCommand(COMMANDS.managerStop, {
		description: "Stop the Telegram business manager (mode 2).",
		handler: stub("/telegram-manager-stop"),
	});
}
