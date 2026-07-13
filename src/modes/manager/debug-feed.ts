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
	link,
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

	// Header: the interlocutor this turn is about — full name, with @username and
	// phone (when shared) in parentheses; the sub-mode. Ids and the rest live in a
	// folded "Contact" block below.
	const modeBadge = subMode === "takeover" ? "🎛️ takeover" : "👁️ observer";
	const paren: string[] = [];
	if (log.username) paren.push(`@${log.username}`);
	if (log.phone) paren.push(log.phone);
	const parenSuffix = paren.length > 0 ? ` (${paren.join(", ")})` : "";
	blocks.push(
		paragraph(
			RichHtml.join([
				"💬 ",
				bold(log.contactName),
				parenSuffix,
				`  ·  ${modeBadge}`,
			]),
		),
	);

	// Outcome headline. For a reply, name who it went to (always the interlocutor
	// in a 1:1 business chat) rather than a bare message id.
	const meta: string[] = [];
	if (log.outcome === "reply" && log.replyToMessageId !== undefined) {
		meta.push(`↩︎ to ${log.contactName}`);
	}
	if (log.category) meta.push(log.category);
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

	// Everything else about the contact, folded: the ids and flags you rarely need.
	// Plain identifiers, deliberately: Telegram has no link that opens a PRIVATE chat
	// at a given message (`t.me/<name>/<id>` is channels/groups only, and tg:// with a
	// message_id is ignored by most clients), so a "jump" link promised what it could
	// not deliver and only landed you wherever the chat was last left.
	const detailRows: RichHtml[] = [
		paragraph(RichHtml.join(["Chat: ", inlineCode(`#${log.chatId}`)])),
	];
	// The message this turn is about: the one we answered, else their latest.
	const turnMessageId = log.replyToMessageId ?? log.lastMessageId;
	if (turnMessageId !== undefined) {
		detailRows.push(
			paragraph(RichHtml.join(["Message: ", inlineCode(`#${turnMessageId}`)])),
		);
	}
	if (log.userId) {
		detailRows.push(
			paragraph(RichHtml.join(["User ID: ", inlineCode(log.userId)])),
		);
	}
	if (log.username) detailRows.push(paragraph(`Username: @${log.username}`));
	if (log.phone) detailRows.push(paragraph(`Phone: ${log.phone}`));
	if (log.languageCode) {
		detailRows.push(paragraph(`Language: ${log.languageCode}`));
	}
	if (log.isPremium !== undefined) {
		detailRows.push(paragraph(`Premium: ${log.isPremium ? "yes" : "no"}`));
	}
	if (log.isBot !== undefined) {
		detailRows.push(paragraph(`Bot: ${log.isBot ? "yes" : "no"}`));
	}
	blocks.push(details("ℹ️ Contact", detailRows));

	blocks.push(paragraph(italic(nowLine)));
	return RichHtml.join(blocks);
}

/**
 * Whether a finished turn is not worth a feed card: a silent decision with no
 * reason carries nothing to show (the blank "Stayed silent" entries) and is just
 * noise. Anything with text — a reply, a held draft, a correction, or a silent
 * WITH a reason — still posts.
 */
export function isEmptyFeedTurn(log: ManagerTurnLog): boolean {
	return log.outcome === "silent" && !log.text?.trim();
}

/** Severity of a relayed runtime notice. */
export type ManagerNoticeLevel = "info" | "warning" | "error";

const NOTICE_BADGE: Record<ManagerNoticeLevel, string> = {
	info: "ℹ️ Info",
	warning: "⚠️ Warning",
	error: "⛔ Error",
};

/**
 * A rich card relaying a runtime notice (warning/error/info) to the owner. Turn
 * aborts are our built-in turn-end mechanism, not failures — callers relay those
 * as `info` ("Turn complete"), never as an error.
 */
export function buildManagerNotice(
	level: ManagerNoticeLevel,
	message: string,
	nowLine: string,
): RichHtml {
	return RichHtml.join([
		paragraph(bold(NOTICE_BADGE[level])),
		blockquote([message.trim()]),
		paragraph(italic(nowLine)),
	]);
}
