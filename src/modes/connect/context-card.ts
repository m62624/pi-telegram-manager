/**
 * `/context` — what is in the model's head right now, and what put it there.
 *
 * `/status` says how full the context is. This says what it is full OF, which is the
 * question you actually need answered when the bot starts forgetting the beginning of
 * a conversation: forty files of tool output nobody counted, a compaction that
 * rewrote the history an hour ago, or a leak.
 *
 * Two numbers, deliberately both shown: the EXACT size of the last call, which the
 * model itself reported, and our own ESTIMATE of the context we just built for the
 * next one. They measure different moments and they will not agree — pretending
 * otherwise, by showing only one, is how you end up trusting a number that was never
 * about the thing you are looking at.
 */
import {
	type ContextSnapshot,
	estimateTokens,
	totalChars,
} from "../../core/context-measure";
import { humanTokens } from "./compaction-cards";
import { bullet, card, note } from "./format";

/** The last compaction of this session, if one has happened. */
export interface CompactionMemory {
	at: number;
	/** What the history weighed on the way in. */
	tokensBefore: number;
}

export interface ContextReportInput {
	/** The last context we built for the model; absent until the first turn. */
	snapshot?: ContextSnapshot;
	/** Pi's own reading of the last call — exact, because the model counted it. */
	usage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	/** The last compaction, whoever triggered it. */
	compaction?: CompactionMemory;
	/**
	 * The head of the last provider request — the system prompt plus the tool schemas —
	 * and whether it has been changing. `snapshot` cannot see this: it measures the
	 * messages WE build, and the head is built by Pi, ahead of all of them.
	 *
	 * It belongs on this card because it is the only part of the prompt whose SIZE is not
	 * the thing that matters. A head is either the same bytes as last time, in which case
	 * a backend re-reads none of it, or it is not, in which case it re-reads all of it —
	 * and everything after it too.
	 */
	head?: {
		chars: number;
		tools: number;
		/** Head changes seen mid-run: nothing about the model changed, only our bookkeeping. */
		defects: number;
		/** What the last mid-run change did, if there was one. */
		lastDefect?: { toolsRemoved: string[]; toolsAdded: string[]; at: number };
	};
	/** Clock, for "8 minutes ago". */
	now: number;
}

const SOURCE_LABEL: Record<ContextSnapshot["source"], string> = {
	personal: "your session — the whole conversation, as the terminal sees it",
	"mixed-coding": "your session, with the Telegram turns stripped out",
	"manager-chat": "one chat only — rebuilt for this conversation, nothing else",
};

export function renderContextCard(input: ContextReportInput): string {
	const { snapshot, usage } = input;
	if (!snapshot) {
		return card("🧠", "Context", [
			"Nothing has been sent to the model yet, so there is nothing to measure.",
			note("Ask me something, then run /context again."),
		]);
	}

	const body: string[] = [bullet("Built from", SOURCE_LABEL[snapshot.source])];

	const exact = exactLine(usage);
	if (exact) body.push(bullet("Last call", exact));

	body.push(
		bullet(
			"Next call",
			`~${humanTokens(estimateTokens(totalChars(snapshot)))} tokens estimated, over ${snapshot.messages} ${plural(snapshot.messages, "message")}`,
		),
	);

	body.push(bullet("Made of", composition(snapshot)));

	if (snapshot.images > 0) {
		body.push(
			bullet(
				"Images",
				`${snapshot.images} inline — each one costs far more than its text`,
			),
		);
	}

	const head = headLine(input);
	if (head) body.push(bullet("Prompt head", head));

	const churn = churnLine(input);
	if (churn) body.push(churn);

	const compaction = compactionLine(input);
	if (compaction) body.push(bullet("Compacted", compaction));

	// The one line that turns the numbers into an action, and only when they call for
	// one: past ~80% a compaction is coming, and it will land wherever it lands.
	if (usage?.percent !== null && usage?.percent !== undefined) {
		if (usage.percent >= 80) {
			body.push(
				note(
					"Nearly full — a compaction will rewrite the history soon. /compact does it now, on your terms; /clear starts over.",
				),
			);
		}
	}

	return card("🧠", "Context", body);
}

/**
 * `~24.3k tokens — 31 tools, sent ahead of every message` — the part of the prompt nobody
 * writes and everybody pays for, on every single call.
 */
function headLine(input: ContextReportInput): string | undefined {
	if (!input.head) return undefined;
	const { chars, tools } = input.head;
	return `~${humanTokens(estimateTokens(chars))} tokens — ${tools} ${plural(tools, "tool")}, sent ahead of every message`;
}

/**
 * The alarm. A head that changes between two calls of ONE run means the backend threw away
 * everything it had read — not because the conversation moved on, but because we handed it
 * different bytes. It is never correct, and until this line existed nobody could see it.
 */
function churnLine(input: ContextReportInput): string | undefined {
	const head = input.head;
	if (!head?.defects) return undefined;
	const last = head.lastDefect;
	const what = last
		? [
				last.toolsRemoved.length > 0
					? `lost ${last.toolsRemoved.join(", ")}`
					: undefined,
				last.toolsAdded.length > 0
					? `gained ${last.toolsAdded.join(", ")}`
					: undefined,
			]
				.filter(Boolean)
				.join("; ")
		: "";
	const detail = what
		? ` (${humanAgo(input.now - (last?.at ?? input.now))}: ${what})`
		: "";
	return note(
		`⚠️ The prompt head changed mid-turn ${head.defects}× this session${detail} — the whole prompt is re-read when it does. This is a bug, not a setting.`,
	);
}

/** `24.5k of 131k (19% full)` — what the model actually counted, last time. */
function exactLine(usage: ContextReportInput["usage"]): string | undefined {
	if (!usage || usage.tokens === null) return undefined;
	const window =
		usage.contextWindow > 0 ? ` of ${humanTokens(usage.contextWindow)}` : "";
	const percent =
		usage.percent === null ? "" : ` (${Math.round(usage.percent)}% full)`;
	return `${humanTokens(usage.tokens)}${window} tokens${percent}`;
}

/**
 * `tools ~29k (76%) · you ~4k · me ~4k · instructions ~1k` — biggest part first,
 * because the whole point is to see the part nobody chose.
 */
function composition(snapshot: ContextSnapshot): string {
	const total = totalChars(snapshot);
	if (total === 0) return "nothing yet";
	const parts: Array<[string, number]> = [
		["tool output", snapshot.chars.tool],
		["your messages", snapshot.chars.user],
		["my replies", snapshot.chars.assistant],
		["instructions", snapshot.chars.instructions],
	];
	return parts
		.filter(([, chars]) => chars > 0)
		.sort((a, b) => b[1] - a[1])
		.map(
			([label, chars]) =>
				`${label} ~${humanTokens(estimateTokens(chars))} (${Math.round((chars / total) * 100)}%)`,
		)
		.join(" · ");
}

/**
 * The line that explains a bot which "forgot the beginning". A compaction replaces
 * the history with a summary the model wrote of itself — everything before it is
 * gone, and the only honest thing to do is say so, and say when.
 */
function compactionLine(input: ContextReportInput): string | undefined {
	if (!input.compaction) return undefined;
	const { at, tokensBefore } = input.compaction;
	const ago = humanAgo(input.now - at);
	const was =
		tokensBefore > 0
			? `, ${humanTokens(tokensBefore)} tokens replaced by a summary`
			: "";
	return `${ago}${was} — anything older than that, I know only from the summary`;
}

function humanAgo(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

/** The same card as plain text, for the manager DM (no rich rendering there). */
export function renderContextText(input: ContextReportInput): string {
	return renderContextCard(input)
		.replace(/\*\*/g, "")
		.replace(/^- /gm, "• ")
		.replace(/[_`]/g, "");
}
