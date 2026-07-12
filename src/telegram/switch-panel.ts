/**
 * Pure building blocks for the `/switch` inline-keyboard panel — the in-chat UI
 * that lets the owner flip the bot between its runtime modes with a tap instead
 * of a terminal command.
 *
 * Everything here is a pure function over structural types (no grammY runtime,
 * no SDK), so the panel layout and the callback parsing are unit-testable; the
 * composition root (`index.ts`) wires the parsed target to the mode lifecycle.
 */
import type { InlineKeyboardMarkup } from "@grammyjs/types";

/**
 * A mode the owner can switch to with a tap. `observer`/`takeover` are the two
 * mode-2 (business manager) sub-modes; `mixed-observer`/`mixed-takeover` run mixed
 * mode (coding + Telegram moderation in one session) in the chosen sub-mode;
 * `personal` is mode 1 (terminal continuation); `stop` tears everything down.
 */
export type SwitchTarget =
	| "observer"
	| "takeover"
	| "mixed-observer"
	| "mixed-takeover"
	| "personal"
	| "stop";

/**
 * The runtime's current mode for display/pin purposes. Every mode — including
 * mixed, now a first-class switch target — is a {@link SwitchTarget}, so the pin
 * and panel caption always mirror exactly what a button can select.
 */
export type PanelMode = SwitchTarget;

interface SwitchOption {
	target: SwitchTarget;
	emoji: string;
	label: string;
}

/** The buttons, in display order (2 columns). */
const SWITCH_OPTIONS: readonly SwitchOption[] = [
	{ target: "observer", emoji: "👁️", label: "Observer" },
	{ target: "takeover", emoji: "🎛️", label: "Takeover" },
	{ target: "mixed-observer", emoji: "🔀", label: "Mixed · Observer" },
	{ target: "mixed-takeover", emoji: "🔀", label: "Mixed · Takeover" },
	{ target: "personal", emoji: "🤖", label: "Personal" },
	{ target: "stop", emoji: "⏹️", label: "Stop" },
];

/** The `callback_data` namespace so a press is unambiguously ours. */
const CALLBACK_PREFIX = "switch:";

/** The set of valid targets, for fast membership checks. */
const TARGETS = new Set<string>(SWITCH_OPTIONS.map((option) => option.target));

/** Human label for a mode, e.g. `👁️ Observer` / `🔀 Mixed · Observer` — for acks/status. */
export function switchLabel(target: PanelMode): string {
	const option = SWITCH_OPTIONS.find((o) => o.target === target);
	return option ? `${option.emoji} ${option.label}` : target;
}

/**
 * Build the inline keyboard (2 columns). The button matching `active` is marked
 * with a check so the current mode is obvious; each button carries
 * `switch:<target>` as its `callback_data`.
 */
export function buildSwitchKeyboard(active: PanelMode): InlineKeyboardMarkup {
	const buttons = SWITCH_OPTIONS.map((option) => ({
		text:
			option.target === active
				? `✅ ${option.emoji} ${option.label}`
				: `${option.emoji} ${option.label}`,
		callback_data: `${CALLBACK_PREFIX}${option.target}`,
	}));
	const rows: (typeof buttons)[] = [];
	for (let i = 0; i < buttons.length; i += 2)
		rows.push(buttons.slice(i, i + 2));
	return { inline_keyboard: rows };
}

/** The panel's caption, naming the currently active mode above the buttons. */
export function switchPanelText(active: PanelMode): string {
	return `Bot mode — choose below.\nCurrent: ${switchLabel(active)}`;
}

/** Whether a plain message is the `/switch` command (bare or `/switch@bot`). */
export function isSwitchCommand(text: string): boolean {
	return /^\/switch(@\w+)?$/i.test(text.trim());
}

/**
 * Parse a button press's `callback_data` (`switch:<target>`) into its target,
 * or null when the data is absent, malformed, or not ours — so a foreign
 * callback is ignored, not misrouted.
 */
export function parseSwitchData(data: string | undefined): SwitchTarget | null {
	if (!data?.startsWith(CALLBACK_PREFIX)) return null;
	const target = data.slice(CALLBACK_PREFIX.length);
	return TARGETS.has(target) ? (target as SwitchTarget) : null;
}
