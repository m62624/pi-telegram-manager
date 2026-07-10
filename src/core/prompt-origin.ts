/**
 * Provenance of a prompt reaching the agent, as a typed category rather than
 * fragile text matching.
 *
 * Pi's `InputEvent.source` is the runtime's own provenance label — we map it to
 * a first-class {@link PromptOrigin} so callers reason about categories, not raw
 * strings. In mode 1 the bridge mirrors only `terminal` prompts into Telegram,
 * so our own Telegram-injected messages (which arrive as `extension`) never echo
 * back — no marker or loop-guard needed.
 *
 * Note the deliberate boundary: this classifies mode-1 *input* provenance from a
 * source field. Mode-2 "bot vs owner" identity is a different problem — there
 * Telegram delivers outgoing business messages with no source field, so it needs
 * an in-message id marker (see the planned `modes/manager/identity.ts`), not this.
 *
 * Pure, no SDK/grammY import (SDK types stay in `src/pi/`); `index.ts` passes the
 * raw `event.source` string in.
 */

/** Where a prompt came from. */
export type PromptOrigin =
	| "terminal" // typed at the Pi TUI (InputEvent source "interactive")
	| "telegram" // injected by this bridge from a Telegram message
	| "programmatic" // rpc / automation (InputEvent source "rpc")
	| "external"; // some other extension's injection

/** Map Pi's `InputEvent.source` string to a {@link PromptOrigin}. */
export function classifyInputSource(source: string): PromptOrigin {
	switch (source) {
		case "interactive":
			return "terminal";
		case "rpc":
			return "programmatic";
		default:
			// "extension" — our own Telegram injection or another extension's.
			return "external";
	}
}

/** Whether a prompt of this origin should be mirrored into the bound Telegram chat. */
export function shouldMirrorToTelegram(origin: PromptOrigin): boolean {
	return origin === "terminal";
}

/** Marker prefixed to a terminal prompt mirrored into Telegram, for a unified history. */
export const TERMINAL_ORIGIN_MARKER = "🖥 from Pi terminal";
