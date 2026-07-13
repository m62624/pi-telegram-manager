/**
 * Decide whether the tool's OWN full-output file should be attached to the chat.
 *
 * When a tool truncates its output for the model, it writes the whole thing to a
 * file and reports the path (`details.fullOutputPath`). That file is the answer to
 * "… (75 earlier lines)" — but it sits on the machine running Pi, useless to
 * anyone reading Telegram on a phone. Attaching it closes that gap.
 *
 * Two rules, both the owner's:
 *  - only when the output was actually TRUNCATED — a complete result is already in
 *    the card, and sending it again as a file is noise;
 *  - only up to `maxBytes`, because the person reading this may be on mobile data.
 *    `0` disables attachment entirely.
 *
 * This is deliberately OUR decision, not the model's: the agent would have to spend
 * a turn deciding, and would get it wrong. Pure and structural, so the rule is
 * testable without a filesystem or a bot.
 */

/** The tool metadata we read (the SDK's `details`, narrowed). */
export interface ToolOutputDetails {
	fullOutputPath?: unknown;
	truncation?: { truncated?: unknown } | unknown;
}

export type AttachSkipReason =
	| "disabled"
	| "no_file"
	| "not_truncated"
	| "too_large";

export type AttachDecision =
	| { attach: true; path: string }
	| { attach: false; reason: AttachSkipReason };

/** Whether the tool says it truncated. Absent metadata means "no claim" → no. */
export function wasTruncated(details: unknown): boolean {
	const truncation = (details as { truncation?: unknown } | undefined)
		?.truncation;
	if (!truncation || typeof truncation !== "object") return false;
	return (truncation as { truncated?: unknown }).truncated === true;
}

/** The tool's saved full-output path, when it reported one. */
export function fullOutputPath(details: unknown): string | undefined {
	const path = (details as { fullOutputPath?: unknown } | undefined)
		?.fullOutputPath;
	return typeof path === "string" && path.trim() ? path : undefined;
}

/**
 * Decide, given the tool's metadata and the file's size on disk. `sizeBytes` is
 * `undefined` when the file could not be measured (it vanished, or was never
 * written) — that is a skip, not an error: the card still names the path.
 */
export function decideAttachment(input: {
	details: unknown;
	maxBytes: number;
	sizeBytes: number | undefined;
}): AttachDecision {
	const { details, maxBytes, sizeBytes } = input;
	if (maxBytes <= 0) return { attach: false, reason: "disabled" };
	const path = fullOutputPath(details);
	if (!path || sizeBytes === undefined) {
		return { attach: false, reason: "no_file" };
	}
	if (!wasTruncated(details)) return { attach: false, reason: "not_truncated" };
	if (sizeBytes > maxBytes) return { attach: false, reason: "too_large" };
	return { attach: true, path };
}
