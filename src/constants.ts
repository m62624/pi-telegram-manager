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
/** The README's setup section — where a misconfigured bot points the owner. */
export const SETUP_GUIDE_URL =
	"https://github.com/m62624/pi-telegram-manager#getting-started";

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
	/** Business manager — answer other people on the owner's behalf. */
	manager: "telegram-manager",
	/** Mixed — coding + Telegram moderation in one session. */
	mixed: "telegram-mixed",
	/** Stop whichever Telegram mode is currently active. */
	stop: "telegram-stop",
	/** Print the active bridge status. */
	status: "telegram-status",
} as const;

/**
 * The OWNER's command menu, published with a chat-scoped `setMyCommands`. It
 * renders as a tappable list behind the chat's menu button — the user never types
 * these by hand — and maps to the bridge's own control handlers, not the agent.
 *
 * Scope matters: every command here is refused to anyone but the owner
 * (`allowedUserId`), so advertising them to the world only invited strangers to
 * tap "Stop the bot entirely" and wonder why nothing happened.
 */
export const TELEGRAM_BOT_COMMANDS: { command: string; description: string }[] =
	[
		{ command: "start", description: "Privacy & terms" },
		{ command: "esc", description: "Cancel the current turn" },
		{
			command: "status",
			description: "Model, context, working directory, queue",
		},
		{
			command: "context",
			description: "What I am carrying, and what filled it up",
		},
		{ command: "clear", description: "Clear the conversation history" },
		{
			command: "compact",
			description: "Summarise the history to free up context",
		},
		{
			command: "switch",
			description: "Switch bot mode (manager / personal / mixed)",
		},
		{ command: "stop", description: "Stop the bot entirely" },
		{ command: "help", description: "Show available commands" },
	];

/**
 * What everyone ELSE sees (the default scope). A stranger who opens this bot gets
 * one command, and it is the one they are entitled to: what the bot is and the
 * terms it runs under. The control surface is not theirs to see.
 */
export const TELEGRAM_PUBLIC_COMMANDS: {
	command: string;
	description: string;
}[] = [{ command: "start", description: "What this bot is — privacy & terms" }];

/**
 * The mutually-exclusive runtime modes. `connect` = personal (mode 1), `manager`
 * = business manager (mode 2), `mixed` = coding + Telegram moderation sharing one
 * session. The internal `connect` identifier is kept even though the user-facing
 * command is now `telegram-personal`.
 */
export type BridgeMode = "connect" | "manager" | "mixed";
