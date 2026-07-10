/**
 * The mode-2 warning banner shown above the editor while the manager owns this
 * Pi session.
 *
 * A manager session multiplexes many business chats through one agent, so the
 * session must not be used as an ordinary chat. The banner makes that loud:
 * "this session is busy running the Telegram manager — stop it and start a new
 * session before using it normally". Content is a pure function of the manager's
 * status so it is trivially testable; `index.ts` pushes it via `ui.setWidget`.
 */

export interface ManagerBannerStatus {
	/** Sub-mode in effect. */
	subMode: "observer" | "takeover";
	/** The chat currently being served, if any. */
	activeChat?: string;
	/** How many chats are waiting their turn. */
	queued: number;
}

/** The banner text lines for `ui.setWidget`. */
export function managerBannerLines(status: ManagerBannerStatus): string[] {
	const active = status.activeChat ? `active: ${status.activeChat}` : "idle";
	return [
		"⚠️ Telegram MANAGER is running in this session.",
		`mode: ${status.subMode} · ${active} · queued: ${status.queued}`,
		"Stop it (/telegram-manager-stop) and start a new session to use Pi normally.",
	];
}
