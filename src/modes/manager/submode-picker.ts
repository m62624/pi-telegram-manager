/**
 * TUI sub-mode picker shared by `/telegram-manager` and `/telegram-mixed`.
 *
 * Both entry commands run the manager in one of two sub-modes; instead of two
 * separate commands per entry, the command shows a Pi selector (`ctx.ui.select`)
 * with a one-line hint for each choice, mirroring pi-planner's command pickers.
 * This module is the pure, unit-testable core: it takes a minimal `select`
 * surface and returns the chosen {@link ManagerSubMode}, or `null` when the user
 * dismisses the dialog.
 */
import type { ManagerSubMode } from "../../storage/singleton-store";

/** The minimal UI surface the picker needs (satisfied by `ctx.ui`). */
export interface SubModePickerUi {
	select(
		title: string,
		options: string[],
		opts?: { timeout?: number },
	): Promise<string | undefined>;
}

/** The two options, each a label line the selector renders. */
export const OBSERVER_OPTION =
	"observer — co-pilot: you answer; the bot suggests and backs you up";
export const TAKEOVER_OPTION =
	"takeover — the bot runs the chat for you while you are away";

/**
 * Ask the owner which manager sub-mode to start. Returns the chosen sub-mode, or
 * `null` if the dialog was dismissed (no selection).
 */
export async function selectManagerSubMode(
	ui: SubModePickerUi,
	title = "Telegram manager sub-mode",
): Promise<ManagerSubMode | null> {
	const choice = await ui.select(title, [OBSERVER_OPTION, TAKEOVER_OPTION]);
	if (choice === OBSERVER_OPTION) return "observer";
	if (choice === TAKEOVER_OPTION) return "takeover";
	return null;
}
