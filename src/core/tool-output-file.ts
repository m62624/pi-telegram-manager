/**
 * Decide whether the FULL output of a tool call should be attached to the chat.
 *
 * A card can only show so much. When it stops at "… (59 earlier lines)", the rest
 * has to be reachable, or the card is just teasing. There are two ways the rest
 * exists, and the reason this module is not a one-liner:
 *
 *  - the TOOL truncated its own output for the model, and saved the whole thing to
 *    a file (`details.fullOutputPath`) — a file we can send as it is;
 *  - the tool returned everything, and WE truncated it to fit the card — so the
 *    full output is in hand, and we can save it ourselves.
 *
 * Only the first case existed at first, which produced exactly the wrong answer for
 * `find … | head -100`: a hundred lines is nothing to the tool's limits, so it
 * truncated nothing and saved no file, while our own card cut it at 2500 characters
 * and offered nothing to open. Truncation is truncation, whoever did it.
 *
 * Both are capped by the owner's byte limit (`0` disables attachment entirely) —
 * whoever reads this may be on mobile data. And it stays OUR decision, never the
 * model's: it is a mechanical rule, and asking the agent would cost a turn and
 * invite it to get it wrong.
 */

export type AttachSkipReason =
	/** `toolOutputMaxBytes` is 0. */
	| "disabled"
	/** Nothing was truncated: the card already shows the whole result. */
	| "not_truncated"
	/** Past the owner's byte cap. */
	| "too_large";

export type AttachPlan =
	/** The tool saved the log itself; send that file. */
	| { attach: "file"; path: string }
	/** We hold the full output; write it out and send it. */
	| { attach: "text"; text: string }
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

export interface AttachmentInput {
	/** The tool's own metadata (`fullOutputPath`, `truncation`). */
	details: unknown;
	/** The tool's output as we have it, already unwrapped from the SDK envelope. */
	text: string;
	/** How many characters of it the card actually shows. */
	shownChars: number;
	/** The owner's cap in bytes; `0` never attaches. */
	maxBytes: number;
	/** Size of the tool's own saved file, when it has one and it could be measured. */
	toolFileBytes?: number;
}

export function planAttachment(input: AttachmentInput): AttachPlan {
	const { details, text, shownChars, maxBytes, toolFileBytes } = input;
	if (maxBytes <= 0) return { attach: false, reason: "disabled" };

	// The tool's own file wins when it exists: it holds the output in FULL, while the
	// text we were handed is the copy the tool already cut down for the model.
	const path = fullOutputPath(details);
	if (wasTruncated(details) && path !== undefined) {
		if (toolFileBytes === undefined) {
			// The path was reported but the file is unreadable/gone. Fall through: what
			// we hold is still better than nothing, if the card cut it.
		} else if (toolFileBytes > maxBytes) {
			return { attach: false, reason: "too_large" };
		} else {
			return { attach: "file", path };
		}
	}

	// Nobody truncated: the card shows everything, and a file would be a duplicate.
	if (text.length <= shownChars) {
		return { attach: false, reason: "not_truncated" };
	}
	if (byteLength(text) > maxBytes)
		return { attach: false, reason: "too_large" };
	return { attach: "text", text };
}

/** UTF-8 size, not character count — the cap is in bytes, and text is not ASCII. */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * The name a tool's full output is DELIVERED under.
 *
 * `.txt`, not `.log`: the file is plain text either way, but a phone knows how to open
 * a `.txt` and offers to preview it, while a `.log` it treats as an unknown blob you
 * have to find an app for. The extension is the only thing standing between the owner
 * and the log they asked for, so it says what the file actually is.
 *
 * Windows forbids `:` `\` `/` `*` `?` `"` `<` `>` `|` in a name — and a timestamp is
 * the first thing that would smuggle a colon in — so everything outside a safe set is
 * folded to `-`.
 */
export function toolOutputFileName(toolName: string, at: number): string {
	const safeTool =
		toolName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "tool";
	return `${safeTool}-${at}.txt`;
}
