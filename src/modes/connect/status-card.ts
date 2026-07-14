/**
 * `/status` — what the bot is, right now, for someone holding a phone.
 *
 * Everything here is something you cannot see from the phone and would otherwise have
 * to walk to the machine for: which model is answering, how close the context is to
 * full (the number that decides when a compaction lands mid-sentence), which directory
 * the agent is working in, whether it is busy, and what is still waiting to be sent.
 *
 * Nothing is invented. A value Pi does not report is left OUT of the card rather than
 * guessed at or printed as "unknown" — a status line nobody can trust is worse than a
 * shorter one that is entirely true.
 */
import { humanTokens } from "./compaction-cards";
import { bullet, card, note } from "./format";

/** Which runtime is up, and — in mixed — which side of it currently holds the session. */
export interface StatusMode {
	mode: "personal" | "manager" | "mixed";
	/** Mixed only: `coding` = the owner has the brain, `telegram` = the manager does. */
	polarity?: "coding" | "telegram";
}

export interface StatusInput {
	runtime: StatusMode;
	/** The model answering, as Pi names it. */
	model?: { name?: string; id?: string; provider?: string };
	/** Context usage; either number may be unknown, and then it is not shown. */
	context?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	/** Working directory of the session. */
	cwd?: string;
	sessionName?: string;
	thinkingLevel?: string;
	/** Whether a turn is running right now. */
	busy: boolean;
	/** Owner messages waiting in our queue (personal/mixed). */
	queued?: number;
	/** Manager side: chats queued, and chats held in the owner-reply window. */
	manager?: { activeChat?: string; queued: number; holding: number };
	/** How long the current mode has been up. */
	uptimeMs?: number;
}

const MODE_LABEL: Record<StatusMode["mode"], string> = {
	personal: "Personal",
	manager: "Secretary manager",
	mixed: "Mixed",
};

export function renderStatusCard(input: StatusInput): string {
	const body: string[] = [bullet("Mode", modeLine(input.runtime))];

	const model = modelLine(input.model);
	if (model) body.push(bullet("Model", model));

	const context = contextLine(input.context);
	if (context) body.push(bullet("Context", context));

	if (input.thinkingLevel) body.push(bullet("Thinking", input.thinkingLevel));
	// The directory decides what `read` and `bash` can even reach, so it belongs in a
	// status you check before asking the bot to touch a file.
	if (input.cwd) body.push(bullet("Working in", `\`${input.cwd}\``));
	if (input.sessionName) body.push(bullet("Session", input.sessionName));

	body.push(bullet("Agent", input.busy ? "working on a turn" : "idle"));
	if (input.queued !== undefined && input.queued > 0) {
		body.push(
			bullet("Queued", `${input.queued} ${plural(input.queued, "message")}`),
		);
	}

	const manager = managerLine(input.manager);
	if (manager) body.push(bullet("Chats", manager));

	if (input.uptimeMs !== undefined) {
		body.push(bullet("Up for", humanDuration(input.uptimeMs)));
	}

	return card("📊", "Status", body);
}

function modeLine(runtime: StatusMode): string {
	const label = MODE_LABEL[runtime.mode];
	if (runtime.mode !== "mixed" || !runtime.polarity) return label;
	// In mixed, the mode alone says nothing about who has the brain THIS second.
	return runtime.polarity === "coding"
		? `${label} — you have the session (coding)`
		: `${label} — the manager has the session (Telegram)`;
}

function modelLine(model: StatusInput["model"]): string | undefined {
	if (!model) return undefined;
	const name = model.name?.trim() || model.id?.trim();
	if (!name) return undefined;
	const provider = model.provider?.trim();
	return provider ? `${name} (${provider})` : name;
}

/** `~77k of 131k (59% full)` — the number that says when a compaction is coming. */
function contextLine(context: StatusInput["context"]): string | undefined {
	if (!context || context.tokens === null) return undefined;
	const used = `~${humanTokens(context.tokens)}`;
	const total =
		context.contextWindow > 0
			? ` of ${humanTokens(context.contextWindow)}`
			: "";
	const percent =
		context.percent === null ? "" : ` (${Math.round(context.percent)}% full)`;
	return `${used}${total} tokens${percent}`;
}

function managerLine(manager: StatusInput["manager"]): string | undefined {
	if (!manager) return undefined;
	const parts: string[] = [];
	if (manager.activeChat) parts.push("1 being answered");
	if (manager.queued > 0) parts.push(`${manager.queued} queued`);
	// Held = the owner still has their 5 minutes to answer first.
	if (manager.holding > 0) parts.push(`${manager.holding} waiting for you`);
	return parts.length > 0 ? parts.join(", ") : "nothing pending";
}

function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

/** `3m`, `2h 14m`, `1d 3h` — how long the mode has been up, at the scale that matters. */
export function humanDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** The same thing as plain text, for the modes that have no rich card (manager DM). */
export function renderStatusText(input: StatusInput): string {
	return renderStatusCard(input)
		.replace(/\*\*/g, "")
		.replace(/^- /gm, "• ")
		.replace(/[_`]/g, "");
}

/** Nothing is running: say that, and say what starts something. */
export function inactiveStatusCard(): string {
	return card("💤", "Status", [
		"No Telegram mode is running.",
		note("/switch starts one."),
	]);
}
