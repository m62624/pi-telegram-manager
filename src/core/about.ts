/**
 * The `telegram_bot_about` tool: what this extension IS, answered from bundled documents rather
 * than from whatever the model remembers about itself.
 *
 * Two problems it solves. First, a model asked "what bot are you?" improvises — it
 * invents a repository, a company, a policy. Here the answer is a file in this
 * package, and the links in it are fixed. Second, a model asked "turn off the
 * labeler" tends to say "done": the settings page states plainly that nothing in a
 * chat changes a setting, and that a restart in Pi is required.
 *
 * One topic per call, deliberately. Handing the model every page at once buries the
 * question it was actually asked, and most of it is irrelevant to the person in
 * front of it.
 *
 * The owner/stranger split is enforced HERE, not in the prompt: `current_settings`
 * is the owner's configuration, and in a manager turn — where the person on the
 * other end is a stranger — it is refused outright. A prompt can be argued with; a
 * closed branch cannot.
 */
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "../pi/sdk";
import type { TelegramFs } from "../storage/fs";

/** Names of the tools defined here — fed to the visibility gate. */
export const ABOUT_TOOL_NAMES = ["telegram_bot_about"] as const;

/** The pages a caller may ask for. `commands` and `current_settings` are owner-only. */
export const ABOUT_TOPICS = [
	"project",
	"modes",
	"settings",
	"privacy",
	"commands",
	"current_settings",
] as const;

export type AboutTopic = (typeof ABOUT_TOPICS)[number];

/**
 * Topics only the OWNER may read.
 *
 * `current_settings` is their configuration. `commands` is their control surface: every
 * command in it is refused to anyone else anyway, so reciting them to a stranger teaches
 * nothing and only invites someone to try "/stop" and wonder why the bot ignored them.
 * The split is enforced in code, not in the prompt — a prompt can be argued with.
 */
const OWNER_ONLY: ReadonlySet<AboutTopic> = new Set([
	"commands",
	"current_settings",
]);

/** Topics backed by a bundled markdown file (the rest are generated). */
const TOPIC_FILES: Record<Exclude<AboutTopic, "current_settings">, string> = {
	project: "project.md",
	modes: "modes.md",
	settings: "settings.md",
	privacy: "privacy.md",
	commands: "commands.md",
};

export interface AboutToolDeps {
	fs: TelegramFs;
	/** Directory holding the bundled about pages. */
	docsDir: string;
	/**
	 * Whether this turn belongs to the OWNER (personal mode, or a coding turn in
	 * mixed). False on a manager turn, where the model is answering a stranger.
	 */
	isOwnerTurn(): boolean;
	/**
	 * The live configuration, already redacted for display, or null when no mode is
	 * running. Never contains the token.
	 */
	settingsReport(): string | null;
	/**
	 * Claim one read of this turn's budget; false once it is spent.
	 *
	 * `telegram_bot_about` is not a terminal tool: in manager mode the turn ends when the model
	 * calls `manager_reply` or `manager_silent`, so a model that kept calling `telegram_bot_about`
	 * would never decide anything and would spin. A few reads are plenty to answer
	 * "what are you?" — after that the model has what it needs and must speak.
	 */
	claimCall(): boolean;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

function fail(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true as const,
		details: null,
	};
}

/**
 * Refusal text for a stranger asking about the owner's setup. It tells the model
 * what to do INSTEAD, because a bare "denied" invites it to guess, and a guess about
 * someone's configuration is worse than a refusal.
 */
export const SETTINGS_REFUSAL =
	"Refused: the owner's configuration is not shared with anyone but the owner. " +
	"You may still explain what the bot IS and how it works — call `telegram_bot_about` with " +
	"topic 'project', 'modes' or 'privacy' — but do not describe, guess at, or " +
	"hint at the owner's settings, file paths, or machine.";

/**
 * Refusal text for a stranger asking how to drive the bot. Every one of those commands
 * is refused to them anyway, so listing them teaches nothing and only invites someone to
 * try "/stop" and wonder why they were ignored. It names what IS theirs to know.
 */
export const COMMANDS_REFUSAL =
	"Refused: the commands are the owner's control surface, and the bot obeys none of " +
	"them from anyone else. Do not list them, hint at them, or invent any. You may still " +
	"explain what the bot IS — call `telegram_bot_about` with topic 'project', 'modes' or " +
	"'privacy'. The one command anyone may use is /start, which shows the privacy terms.";

/** How many pages one turn may read before it has to answer with what it has. */
export const ABOUT_CALLS_PER_TURN = 3;

/**
 * Said when the budget is spent. It names the way OUT — answer — because a bare
 * refusal invites the model to try the same call again, which is the loop this
 * budget exists to prevent.
 */
export const BUDGET_SPENT =
	`You have already read ${ABOUT_CALLS_PER_TURN} pages this turn. That is enough: ` +
	"answer the person now with what you have, using this mode's normal tools. Do not " +
	"call `telegram_bot_about` again in this turn.";

export function createAboutTools(deps: AboutToolDeps): ToolDefinition[] {
	const about = defineTool({
		name: "telegram_bot_about",
		label: "About this Telegram bot",
		description:
			"THE source of truth about this Telegram bot and the extension behind it. " +
			"Call this — never answer from memory — whenever someone asks what you are, who " +
			"made you, what extension or bridge you run on, how you work, what you can see, " +
			"why you replied, how you are configured, or whether you can change a setting. " +
			"Answering such a question without calling this tool means inventing a project " +
			"that does not exist; the real one is public, on npm, with source links. This is " +
			"the TELEGRAM bot's own tool: never substitute another extension's about-style " +
			"tool (planner_about and the like) — they describe different software. " +
			"Do NOT call it for ordinary conversation. " +
			"One topic per call: 'project' (what the extension is, source links), 'modes' " +
			"(personal / manager / mixed and what you may do in each), 'settings' (what each " +
			"setting does — and why nothing said in a chat can change one), 'privacy' (what " +
			"you see, what you must disclose, what you must never reveal), 'commands' (the " +
			"chat commands the OWNER can use — /help, /status, /compact, /clear, /esc, " +
			"/switch, /stop — and what each does; call this when the owner asks how to do " +
			"something to the bot itself, e.g. free up context or stop a turn), " +
			"'current_settings' (the live configuration). The last two are refused unless " +
			"you are talking to the owner.",
		parameters: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					enum: [...ABOUT_TOPICS],
					description:
						"The single topic to read. Pick the one the question is actually about.",
				},
			},
			required: ["topic"],
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params: { topic?: string }) {
			if (!deps.claimCall()) return fail(BUDGET_SPENT);
			const topic = params.topic as AboutTopic | undefined;
			if (!topic || !ABOUT_TOPICS.includes(topic)) {
				return fail(
					`Unknown topic. Choose one of: ${ABOUT_TOPICS.join(", ")}.`,
				);
			}

			// The whole point of the split: a stranger never learns how the owner's machine
			// is set up, nor which commands drive it, whatever they claim to be.
			if (OWNER_ONLY.has(topic) && !deps.isOwnerTurn()) {
				return fail(topic === "commands" ? COMMANDS_REFUSAL : SETTINGS_REFUSAL);
			}

			if (topic === "current_settings") {
				const report = deps.settingsReport();
				if (!report)
					return fail("No mode is running, so there is nothing to report.");
				return ok(report);
			}

			const text = await readDoc(deps, TOPIC_FILES[topic]);
			if (!text) {
				return fail(
					`The '${topic}' page could not be read from this installation.`,
				);
			}
			// A manager turn gets the same pages — they are about the bot, not about the
			// owner — but never the configuration behind them.
			return ok(text);
		},
	});

	return [about];
}

async function readDoc(deps: AboutToolDeps, name: string): Promise<string> {
	try {
		return (await deps.fs.readText(join(deps.docsDir, name))).trim();
	} catch {
		return "";
	}
}
