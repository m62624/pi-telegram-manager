/**
 * Stable, project-wide constants.
 *
 * `EXTENSION_NAME` names the on-disk data subtree under the Pi agent directory
 * (`<agentDir>/extensions/<EXTENSION_NAME>/`). Keep it in sync with the npm
 * package name so a user can locate their data.
 */
export const EXTENSION_NAME = "pi-telegram-manager";

/** Slash commands this extension registers with Pi. */
export const COMMANDS = {
	/** Mode 1 — bind the current terminal session to a single Telegram DM. */
	connect: "telegram-connect",
	/** Mode 1 — explicitly tear down the terminal-continuation binding. */
	disconnect: "telegram-disconnect",
	/** Mode 1/2 — print the active bridge status. */
	status: "telegram-status",
	/** Mode 2 — start the manager in the observer (co-pilot) sub-mode. */
	managerObserver: "telegram-manager-observer",
	/** Mode 2 — start the manager in the takeover sub-mode. */
	managerTakeover: "telegram-manager-takeover",
	/** Mode 2 — explicitly stop the manager (either sub-mode). */
	managerStop: "telegram-manager-stop",
	/** Mode 1/2 — open the inline mode-switcher panel in the owner's bot DM. */
	switch: "telegram-switch",
} as const;

/**
 * Bot commands published to the Telegram command menu (mode 1) via
 * `setMyCommands`. They render as a tappable list behind the chat's menu
 * button — the user never types them by hand — and map to the bridge's own
 * control handlers, not the agent.
 */
export const TELEGRAM_BOT_COMMANDS: { command: string; description: string }[] =
	[
		{ command: "esc", description: "Cancel the current turn" },
		{ command: "clear", description: "Clear the conversation history" },
		{ command: "commands", description: "List all Pi commands (terminal)" },
		{
			command: "switch",
			description: "Switch bot mode (observer / takeover / personal / stop)",
		},
		{ command: "help", description: "Show available commands" },
	];

/** The two mutually-exclusive runtime modes. */
export type BridgeMode = "connect" | "manager";
