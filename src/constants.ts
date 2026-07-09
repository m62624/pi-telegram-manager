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
	/** Mode 2 — open a fresh manager session in a dedicated directory. */
	manager: "telegram-manager",
	/** Mode 2 — explicitly stop the manager. */
	managerStop: "telegram-manager-stop",
} as const;

/** The two mutually-exclusive runtime modes. */
export type BridgeMode = "connect" | "manager";
