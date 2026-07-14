/**
 * What the chat says around a context compaction.
 *
 * Compaction is the one thing that happens TO the conversation rather than in it: it
 * rewrites the history the model reads, and it takes long enough that a silent pause
 * reads as a hang. So it is narrated — starting, and then the outcome.
 *
 * The outcome is either card, never neither: Pi has no "compaction failed" event, only
 * an `onError` callback, so a compaction that threw used to leave "Compacting context…"
 * standing as the last word in the chat with nothing ever following it.
 */
import { bullet, card, note } from "./format";

/** Why a compaction is running — Pi's own three triggers. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Context usage as Pi reports it; either number can be unknown. */
export interface ContextUsageLike {
	tokens: number | null;
	percent: number | null;
}

const WHY: Record<CompactionReason, string> = {
	manual: "you asked for it (/compact)",
	threshold: "the context is filling up",
	overflow: "the last turn overflowed the context — recovering",
};

/** `840`, `203.5k`, `1.2M` — a token count at a glance, not to the digit. */
export function humanTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "?";
	if (tokens < 1_000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`;
	return `${Math.round(tokens / 100_000) / 10}M`;
}

/** The compaction has begun. Says why, and how full the context was when it did. */
export function compactingCard(
	reason: CompactionReason,
	usage?: ContextUsageLike,
): string {
	const body = [bullet("Why", WHY[reason])];
	const now = usageLine(usage);
	if (now) body.push(bullet("Context", now));
	body.push(note("Freeing up space — one moment…"));
	return card("🗜", "Compacting context", body);
}

/** It worked. `tokensBefore` is what the history weighed on the way in. */
export function compactedCard(tokensBefore?: number): string {
	const body: string[] = [];
	if (tokensBefore !== undefined && tokensBefore > 0) {
		body.push(bullet("Was", `~${humanTokens(tokensBefore)} tokens`));
	}
	body.push(note("Continuing."));
	return card("✅", "Context compacted", body);
}

/**
 * The summariser wrote nothing, twice, so the compaction was called off and the history
 * kept. This is a good outcome standing in for a bad one, and the card has to say both:
 * nothing was lost, and nothing was freed either — the next turn starts from the same
 * full context, and it will keep happening until the owner does something about it.
 */
export function compactionEmptyCard(): string {
	return card("🪫", "Compaction produced no summary", [
		bullet(
			"Kept",
			"the full history — a summary that says nothing is not a summary",
		),
		note(
			"The summariser had no room to answer. /clear starts fresh, or give the model " +
				"more output budget (`maxTokens`) and send /compact again.",
		),
	]);
}

/**
 * It failed. The reason is shown as the model gave it, because the owner is the only
 * one who can act on it (a summariser model that is down, a key that expired).
 */
export function compactionFailedCard(reason: string): string {
	const detail = reason.trim() || "no reason given";
	// In code, because this string is not ours: it comes from whatever failed. Our own
	// messages are sent with entity detection on so their /commands are tappable, and a
	// foreign string must not be able to smuggle a button into one of our cards.
	return card("❌", "Compaction failed", [
		bullet("Reason", `\`${detail.replace(/`/g, "'")}\``),
		note("The context was left as it is — nothing was lost."),
	]);
}

/** `~203.5k tokens (84% full)` — as much of it as Pi actually knows. */
function usageLine(usage?: ContextUsageLike): string | undefined {
	if (!usage || usage.tokens === null) return undefined;
	const tokens = `~${humanTokens(usage.tokens)} tokens`;
	if (usage.percent === null) return tokens;
	return `${tokens} (${Math.round(usage.percent)}% full)`;
}
