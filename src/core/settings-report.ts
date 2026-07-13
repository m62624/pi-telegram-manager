/**
 * The live configuration, rendered for the OWNER to read in a chat.
 *
 * Two rules, and the first one is absolute:
 *
 *  - the bot token never appears. Not truncated, not "starts with", not "ending in".
 *    A token in a chat is a token in Telegram's servers, in a backup, and in whatever
 *    reads that chat next. Only whether one is set.
 *  - it reports what is RUNNING, not what is in the file. Settings are read when a
 *    mode starts, so a `settings.json` edited five minutes ago is not what the bot is
 *    doing — and saying otherwise is the exact confusion this whole feature exists to
 *    prevent.
 *
 * Pure: takes a settings object, returns markdown. `index.ts` decides who may see it.
 */
import type { TelegramSettings } from "../settings/schema";

/** Milliseconds as something a person reads: `5 min`, `1 min 30 s`, `800 ms`. */
export function humanMs(ms: number): string {
	if (ms === 0) return "off";
	if (ms < 1000) return `${ms} ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60)
		return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
	const hours = Math.floor(minutes / 60);
	const restMin = minutes % 60;
	return restMin === 0 ? `${hours} h` : `${hours} h ${restMin} min`;
}

/** Bytes as something a person reads: `25 MiB`, `1 MiB`, `900 B`. */
export function humanBytes(bytes: number): string {
	if (bytes === 0) return "off";
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const rounded =
		value >= 10 || Number.isInteger(value)
			? Math.round(value)
			: Math.round(value * 10) / 10;
	return `${rounded} ${units[unit]}`;
}

const onOff = (value: boolean): string => (value ? "on" : "off");

/** `40000` is a wall of digits; `40k` is a number. `0` means no cap here. */
export function humanCount(value: number): string {
	if (value === 0) return "no cap";
	return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

export interface SettingsReportInput {
	settings: TelegramSettings;
	/** The mode actually running right now. */
	mode: "personal" | "manager" | "mixed";
}

/**
 * Render the running configuration. The header states the one thing that is easiest
 * to get wrong — that these values were read at mode start and that changing them
 * needs a restart in Pi, not a message in a chat.
 */
export function renderSettingsReport(input: SettingsReportInput): string {
	const { settings: s, mode } = input;
	const lines: string[] = [
		`# Configuration currently running (${mode} mode)`,
		"",
		"These are the values this bot STARTED with. Editing `settings.json` does not",
		"change them, and nothing said in a chat does either: the owner must restart the",
		"mode in Pi (`/telegram-personal`, `/telegram-manager`, `/telegram-mixed`) for a",
		"change to take effect. Do not tell anyone a setting has been changed.",
		"",
		"## Identity",
		`- bot token: ${s.botToken ? "set (never shown)" : "not set"}`,
		`- allowedUserId: ${s.allowedUserId ?? "not set"}`,
		`- timezone: ${s.timezone ?? "the host's own"}`,
		"",
	];

	if (mode === "personal" || mode === "mixed") {
		lines.push(
			"## Personal mode",
			`- rendering: ${s.assistant.rendering}`,
			`- draft previews (live typing + what the agent is doing): ${onOff(s.assistant.draftPreviews)}`,
			`- tool activity cards: ${onOff(s.assistant.toolActivity)}`,
			`- attach a tool's full output up to: ${humanBytes(s.assistant.toolOutputMaxBytes)}`,
			`- tool output written to: ${s.assistant.toolOutputDir ?? "the extension's own directory"}`,
			`- files you send are saved to: ${s.files.downloadDir ?? "the directory Pi runs in"}`,
			`- max inbound file size: ${humanBytes(s.files.maxBytes)}`,
			`- max images per turn: ${s.files.maxImagesPerTurn}`,
			"",
		);
	}

	if (mode === "manager" || mode === "mixed") {
		lines.push(
			"## Manager mode",
			`- labeler: ${s.manager.labeler ? `"${s.manager.labeler}"` : "(empty — no label is prefixed)"}`,
			`- owner reply window: ${humanMs(s.manager.ownerReplyWindowMs)} (how long the owner has to answer before the bot may)`,
			`- continuation window: ${humanMs(s.manager.continueWindowMs)}`,
			`- strict reply guard: ${onOff(s.manager.strictReplyGuard)}`,
			`- messages remembered per chat: ${s.manager.rememberMessages}`,
			`- facts remembered per person: ${s.manager.factsLimit}`,
			`- extra tools allowed in the sandbox: ${
				s.manager.allowedTools.length > 0
					? s.manager.allowedTools.join(", ")
					: "none (messaging tools only)"
			}`,
			`- catch-up window on start: ${humanMs(s.manager.catchUpWindowMs)}`,
			`- live-freshness guard: ${humanMs(s.manager.liveFreshnessMs)}`,
			`- re-greet after silence: ${humanMs(s.manager.reopenAfterMs)}`,
			`- facts consolidated after a chat is quiet for: ${humanMs(s.manager.factConsolidationQuietMs)}`,
			`- draft revisions allowed: ${s.manager.reviseThreshold}`,
			`- context caps: ${s.manager.maxCharsPerMessage} chars/message, ${humanCount(s.manager.maxContextChars)} chars total`,
			`- wake words: ${s.manager.mentionWords.length > 0 ? s.manager.mentionWords.join(", ") : "(none beyond the bot's name)"}`,
			`- owner is called: ${s.manager.ownerName || "(not set)"}`,
			`- inbound media: images ${onOff(s.manager.media.images)}, documents ${onOff(s.manager.media.documents)}`,
			`- debug feed to the owner's DM: ${onOff(s.manager.log)}`,
			"",
		);
	}

	if (mode === "mixed") {
		lines.push(
			"## Mixed mode",
			`- return to Telegram after the owner is quiet for: ${humanMs(s.mixed.returnToTelegramMs)}`,
			"",
		);
	}

	lines.push(
		"## Forwards (all modes)",
		`- budget per batch: ${s.forwards.maxMessages} messages, ${humanCount(s.forwards.maxChars)} chars, grouped within ${humanMs(s.forwards.groupWindowMs)}`,
		"",
		"## The owner's DM layout",
		`- topics: ${onOff(s.topics.enabled)}${s.topics.enabled ? ` ("${s.topics.personalName}" / "${s.topics.managerName}")` : ""}`,
		"",
		"## Reliability",
		`- connection watchdog: ${onOff(s.connectionCheck.enabled)}${
			s.connectionCheck.enabled
				? ` (every ${humanMs(s.connectionCheck.intervalMs)}, ${s.connectionCheck.maxRetries} failures to disconnect)`
				: ""
		}`,
	);

	return lines.join("\n").trim();
}
