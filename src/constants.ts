/**
 * Stable, project-wide constants.
 *
 * `EXTENSION_NAME` names the on-disk data subtree under the Pi agent directory
 * (`<agentDir>/extensions/<EXTENSION_NAME>/`). Keep it in sync with the npm
 * package name so a user can locate their data.
 */
export const EXTENSION_NAME = "pi-telegram-manager";

/**
 * Telegram's terms an operator (and anyone connecting the bot) must read and
 * follow. Surfaced on `/start` and in `/help` so using the bot is never separated
 * from the responsibility that comes with it.
 */
export const COMPLIANCE_LINKS = {
	botTerms: "https://telegram.org/tos/bot-developers",
	privacy: "https://telegram.org/privacy",
	/** The Secretary / Business section (acting on a user's behalf). */
	business: "https://telegram.org/tos/bot-developers#5-4-telegram-business",
} as const;

/**
 * Plain-text privacy/compliance reminder shown on `/start` and in `/help`. Raw
 * URLs so a plain Telegram message auto-links them (no Markdown needed).
 */
export const COMPLIANCE_NOTICE = [
	"⚠️ Privacy & terms — please read before using this bot.",
	"",
	"This bot runs pi-telegram-manager and, in Telegram's Secretary (Business) mode, can read and act on messages on the account owner's behalf. By using it you agree to read and follow Telegram's terms:",
	`• Bot Developer Terms: ${COMPLIANCE_LINKS.botTerms}`,
	`• Privacy Policy: ${COMPLIANCE_LINKS.privacy}`,
	`• Secretary / Business section: ${COMPLIANCE_LINKS.business}`,
	"",
	"You alone are responsible for how you use this bot and the data it processes.",
].join("\n");

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
		{ command: "start", description: "Privacy & terms" },
		{ command: "esc", description: "Cancel the current turn" },
		{ command: "clear", description: "Clear the conversation history" },
		{
			command: "switch",
			description:
				"Switch bot mode (observer / takeover / mixed / personal / stop)",
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
