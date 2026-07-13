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
 * A mode the owner can switch to with a tap. `manager` is the business manager
 * (mode 2); `mixed` runs coding + Telegram moderation in one session; `personal`
 * is mode 1 (terminal continuation); `stop` tears everything down.
 */
export type SwitchTarget = "manager" | "mixed" | "personal" | "stop";

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

/**
 * Every mode's label, incl. `stop` (the panel caption and the pin render a
 * stopped bot too, even though no button offers it).
 */
const SWITCH_OPTIONS: readonly SwitchOption[] = [
	{ target: "manager", emoji: "🎛️", label: "Manager" },
	{ target: "mixed", emoji: "🔀", label: "Mixed" },
	{ target: "personal", emoji: "🤖", label: "Personal" },
	{ target: "stop", emoji: "⏹️", label: "Stop" },
];

/**
 * The buttons, in display order (2 columns). `stop` is deliberately NOT among
 * them: a Secretary connection is a long-lived thing, and a stray tap while
 * picking a mode used to kill it. Stopping is its own explicit `/stop` command.
 */
const PANEL_OPTIONS: readonly SwitchOption[] = SWITCH_OPTIONS.filter(
	(option) => option.target !== "stop",
);

/** The `callback_data` namespace so a press is unambiguously ours. */
const CALLBACK_PREFIX = "switch:";

/**
 * Targets a button press may select — the panel's, so `switch:stop` from an old
 * panel still sitting in the chat parses as "not ours" and is ignored.
 */
const TARGETS = new Set<string>(PANEL_OPTIONS.map((option) => option.target));

/** Human label for a mode, e.g. `🎛️ Manager` / `🔀 Mixed` — for acks/status. */
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
	const buttons = PANEL_OPTIONS.map((option) => ({
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
	return `Bot mode — choose below.\nCurrent: ${switchLabel(active)}\nTo stop the bot entirely: /stop`;
}

/** Whether a plain message is the `/switch` command (bare or `/switch@bot`). */
export function isSwitchCommand(text: string): boolean {
	return /^\/switch(@\w+)?$/i.test(text.trim());
}

/**
 * Whether a plain message is the `/stop` command — the only way to stop the bot
 * from Telegram, kept off the panel so it cannot be hit by accident.
 */
export function isStopCommand(text: string): boolean {
	return /^\/stop(@\w+)?$/i.test(text.trim());
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
