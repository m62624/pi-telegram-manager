/**
 * TUI mode picker for `/telegram-switch`.
 *
 * The switcher started life as a Telegram-only surface (an inline keyboard in the
 * owner's DM), which made the terminal command a courier with nothing to say when
 * the bot was off — "start a Telegram mode first" to reach the thing that starts
 * modes. So the command now offers the same choice right here, through Pi's selector,
 * and only *also* pushes the inline panel to the phone when a bot is already running.
 *
 * Pure and unit-testable: it takes a minimal `select` surface and returns the chosen
 * {@link SwitchTarget} (or `"panel"` to send the keyboard to Telegram), `null` when
 * the dialog is dismissed. The live mode is marked so the list doubles as a status
 * readout.
 */
import type { PanelMode, SwitchTarget } from "../../telegram/switch-panel";

/** The minimal UI surface the picker needs (satisfied by `ctx.ui`). */
export interface ModePickerUi {
	select(
		title: string,
		options: string[],
		opts?: { timeout?: number },
	): Promise<string | undefined>;
}

/** What the picker resolves to: a mode to switch to, or the DM panel. */
export type ModeChoice = SwitchTarget | "panel";

/** Every choice, in the order shown, with the one-line hint each label carries. */
const CHOICES: { choice: ModeChoice; label: string }[] = [
	{
		choice: "personal",
		label: "personal — your terminal session, driven from your bot DM",
	},
	{
		choice: "observer",
		label: "observer — the bot answers others only when you stay silent",
	},
	{
		choice: "takeover",
		label: "takeover — the bot runs your chats with other people",
	},
	{
		choice: "mixed-observer",
		label: "mixed · observer — coding + moderation in one session; you lead",
	},
	{
		choice: "mixed-takeover",
		label:
			"mixed · takeover — coding + moderation in one session; the bot leads",
	},
	{ choice: "stop", label: "stop — shut the bot down" },
];

const PANEL_LABEL = "panel — send the switcher keyboard to my bot DM";

/** The label for a choice, marked when it is the mode running right now. */
export function modeOptions(active: PanelMode, botRunning: boolean): string[] {
	const options = CHOICES.map(({ choice, label }) =>
		choice === active ? `${label}  ← active` : label,
	);
	// A keyboard can only be pushed while a bot is polling; offering it otherwise
	// would just reproduce the "start a mode first" dead end.
	if (botRunning) options.push(PANEL_LABEL);
	return options;
}

/**
 * Ask which mode to run. Returns the choice, or `null` when the dialog is dismissed
 * (Pi's selector resolves undefined) or the selection is unrecognised.
 */
export async function selectMode(
	ui: ModePickerUi,
	active: PanelMode,
	botRunning: boolean,
	title = "Telegram mode",
): Promise<ModeChoice | null> {
	const options = modeOptions(active, botRunning);
	const picked = await ui.select(title, options);
	if (picked === undefined) return null;
	const index = options.indexOf(picked);
	if (index < 0) return null;
	if (botRunning && index === options.length - 1) return "panel";
	return CHOICES[index]?.choice ?? null;
}
