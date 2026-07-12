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
 * A mode the owner can switch to. `observer`/`takeover` are the two mode-2
 * (business manager) sub-modes; `personal` is mode 1 (terminal continuation,
 * formerly "OnlyBotForOwner"); `stop` tears everything down.
 */
export type SwitchTarget = "observer" | "takeover" | "personal" | "stop";

interface SwitchOption {
	target: SwitchTarget;
	emoji: string;
	label: string;
}

/** The four buttons, in display order (2×2 grid). */
const SWITCH_OPTIONS: readonly SwitchOption[] = [
	{ target: "observer", emoji: "👁️", label: "Observer" },
	{ target: "takeover", emoji: "🎛️", label: "Takeover" },
	{ target: "personal", emoji: "🤖", label: "Personal" },
	{ target: "stop", emoji: "⏹️", label: "Stop" },
];

/** The `callback_data` namespace so a press is unambiguously ours. */
const CALLBACK_PREFIX = "switch:";

/** The set of valid targets, for fast membership checks. */
const TARGETS = new Set<string>(SWITCH_OPTIONS.map((option) => option.target));

/** Human label for a target, e.g. `👁️ Observer` — for acks and status lines. */
export function switchLabel(target: SwitchTarget): string {
	const option = SWITCH_OPTIONS.find((o) => o.target === target);
	return option ? `${option.emoji} ${option.label}` : target;
}

/**
 * Build the 2×2 inline keyboard. The button matching `active` is marked with a
 * check so the current mode is obvious; each button carries `switch:<target>`
 * as its `callback_data`.
 */
export function buildSwitchKeyboard(active: SwitchTarget): InlineKeyboardMarkup {
	const buttons = SWITCH_OPTIONS.map((option) => ({
		text:
			option.target === active
				? `✅ ${option.emoji} ${option.label}`
				: `${option.emoji} ${option.label}`,
		callback_data: `${CALLBACK_PREFIX}${option.target}`,
	}));
	return { inline_keyboard: [buttons.slice(0, 2), buttons.slice(2, 4)] };
}

/** The panel's caption, naming the currently active mode above the buttons. */
export function switchPanelText(active: SwitchTarget): string {
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
	if (!data || !data.startsWith(CALLBACK_PREFIX)) return null;
	const target = data.slice(CALLBACK_PREFIX.length);
	return TARGETS.has(target) ? (target as SwitchTarget) : null;
}
