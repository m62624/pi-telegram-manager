/**
 * Owner-side debug feed for mode 2 (manager). Because the manager replies AS the
 * owner through the business connection, the bot's own account is otherwise idle
 * — so we repurpose it as an observability channel: after each manager turn the
 * bot DMs the owner a rich card showing which chat was handled, the model's
 * thinking (folded into a `<details>` block), the tool calls it made, and the
 * decision that resulted. This module is the pure formatter; `index.ts` gathers
 * the thinking/tool-calls from the turn's messages and does the actual send.
 */

import type { ManagerSubMode } from "../../storage/singleton-store";
import {
	blockquote,
	bold,
	details,
	inlineCode,
	italic,
	paragraph,
	preformatted,
	RichHtml,
} from "../../telegram/rich-builder";
import type { ManagerTurnLog, ManagerTurnOutcome } from "./controller";

/** Human badge for each turn outcome, shown as the card's headline. */
const OUTCOME_BADGE: Record<ManagerTurnOutcome, string> = {
	reply: "💬 Replied",
	silent: "🤫 Stayed silent",
	held: "✏️ Draft held — new messages arrived",
	corrected: "⚠️ Wrote plain text — re-prompted to use a tool",
};

/** Keep a card comfortably under Telegram's per-message limit. */
const THINKING_LIMIT = 3500;
const TOOL_ARGS_LIMIT = 400;

/** One tool call the model made during the turn. */
export interface ManagerToolCall {
	name: string;
	/** JSON-ish rendering of the call arguments (already stringified). */
	args: string;
}

export interface ManagerFeedEntry {
	log: ManagerTurnLog;
	subMode: ManagerSubMode;
	/** The `[Now: …]` line, shown as a small footer. */
	nowLine: string;
	/** The model's raw reasoning for the turn, if any (folded, collapsed). */
	thinking?: string;
	tools: readonly ManagerToolCall[];
}

/** Trim overlong text, marking how much was cut so nothing looks silently lost. */
function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)} …[+${trimmed.length - max} chars]`;
}

/**
 * Build the rich HTML card mirroring one manager turn to the owner. Returns a
 * {@link RichHtml} ready for `OutboundSender.notify`.
 */
export function buildManagerFeed(entry: ManagerFeedEntry): RichHtml {
	const { log, subMode, nowLine, thinking, tools } = entry;
	const blocks: RichHtml[] = [];

	// Header: who + which chat + which sub-mode.
	const modeBadge = subMode === "takeover" ? "🎛️ takeover" : "👁️ observer";
	blocks.push(
		paragraph(
			RichHtml.join([
				bold(`🧑 ${log.contactName}`),
				"  ",
				inlineCode(`#${log.chatId}`),
				`  ·  ${modeBadge}`,
			]),
		),
	);

	// Outcome headline, with the category and reply target when present.
	const meta: string[] = [];
	if (log.category) meta.push(log.category);
	if (log.replyToMessageId !== undefined) {
		meta.push(`↩︎ #${log.replyToMessageId}`);
	}
	const metaSuffix = meta.length > 0 ? `  ·  ${meta.join("  ·  ")}` : "";
	blocks.push(
		paragraph(RichHtml.join([bold(OUTCOME_BADGE[log.outcome]), metaSuffix])),
	);

	// The decision's own text: a reply/draft as a quote, a silent reason in italics.
	if (log.text?.trim()) {
		if (log.outcome === "silent") {
			blocks.push(paragraph(italic(`“${log.text.trim()}”`)));
		} else {
			blocks.push(blockquote([log.text.trim()]));
		}
	}

	// The model's reasoning, folded so it never dominates the card.
	if (thinking?.trim()) {
		blocks.push(
			details("🧠 Model thinking", [
				preformatted(truncate(thinking, THINKING_LIMIT)),
			]),
		);
	}

	// The tool calls made this turn, folded, one per line.
	if (tools.length > 0) {
		const rows = tools.map((tool) =>
			paragraph(
				RichHtml.join([
					bold(tool.name),
					tool.args ? `  ${truncate(tool.args, TOOL_ARGS_LIMIT)}` : "",
				]),
			),
		);
		blocks.push(details(`🔧 Tools (${tools.length})`, rows));
	}

	blocks.push(paragraph(italic(nowLine)));
	return RichHtml.join(blocks);
}
