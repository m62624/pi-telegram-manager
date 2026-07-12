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
	/** Personal — bind the current terminal session to a single Telegram DM. */
	personal: "telegram-personal",
	/** Business manager — pick observer/takeover, then run the manager. */
	manager: "telegram-manager",
	/** Mixed — coding + Telegram moderation in one session (pick observer/takeover). */
	mixed: "telegram-mixed",
	/** Stop whichever Telegram mode is currently active. */
	stop: "telegram-stop",
	/** Print the active bridge status. */
	status: "telegram-status",
	/** Open the inline mode-switcher panel in the owner's bot DM. */
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
		{
			command: "switch",
			description: "Switch bot mode (observer / takeover / personal / stop)",
		},
		{ command: "help", description: "Show available commands" },
	];

/**
 * The mutually-exclusive runtime modes. `connect` = personal (mode 1), `manager`
 * = business manager (mode 2), `mixed` = coding + Telegram moderation sharing one
 * session. The internal `connect` identifier is kept even though the user-facing
 * command is now `telegram-personal`.
 */
export type BridgeMode = "connect" | "manager" | "mixed";
