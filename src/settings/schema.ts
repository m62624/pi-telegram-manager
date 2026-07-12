import type { ManagerSubMode } from "../storage/singleton-store";

/**
 * Effective settings for the extension. Persisted at
 * `<agentDir>/extensions/pi-telegram-manager/settings.json`. Unknown keys never
 * fail parsing (collected as warnings); present-but-wrong-typed keys throw a
 * `TypeError` with the offending path so misconfig is loud but recoverable.
 */
export interface TelegramSettings {
	botToken?: string;
	allowedUserId?: number;
	/**
	 * IANA timezone (e.g. "Asia/Almaty") for the `[Now: …]` line shown to the
	 * model in both modes. Unset → the host's system timezone.
	 */
	timezone?: string;
	assistant: {
		rendering: "rich" | "html";
		draftPreviews: boolean;
		/** Mirror each agent tool call to Telegram as a collapsible block (mode 1). */
		toolActivity: boolean;
	};
	/**
	 * Background connection watchdog (both modes). While a mode is active the bot
	 * connection is probed on a timer; after `maxRetries` consecutive failures the
	 * mode auto-disconnects. Silent — probes never post to chat or the debug feed.
	 */
	connectionCheck: {
		/** Run the watchdog while a mode is active. Default true. */
		enabled: boolean;
		/** Probe interval in ms. Default 600000 (10 min); `0` also disables it. */
		intervalMs: number;
		/** Consecutive failed probes tolerated before auto-disconnect. Default 3. */
		maxRetries: number;
	};
	/** Markdown instruction files injected as system prompt while any mode is active. */
	instructionFiles: string[];
	connect: {
		instructionFiles: string[];
	};
	manager: {
		/** Continuation/priority window (ms). Default 90000 (1:30). */
		continueWindowMs: number;
		/** Owner-reply window (ms). Default 300000 (5 min). */
		ownerReplyWindowMs: number;
		/**
		 * Catch-up window (ms). On activation the bot may answer for the owner in
		 * chats whose last message is not the owner's and is newer than this.
		 * Default 36000000 (10 h).
		 */
		catchUpWindowMs: number;
		/**
		 * Regex patterns of tool names the model may call in manager mode, on top of
		 * the built-in `manager_reply`/`manager_silent`. Empty = telegram-sandbox
		 * (only the messaging tools; no computer access). Anchored full-name match.
		 */
		allowedTools: string[];
		/** What inbound media the manager forwards to the model. */
		media: {
			/** Let the model scan interlocutor images (vision). Default true. */
			images: boolean;
			/** Accept non-image documents. Default false (they are refused). */
			documents: boolean;
		};
		/** Last-N messages remembered per chat. */
		rememberMessages: number;
		/** Last-N durable facts kept + injected per contact. Default 20. */
		factsLimit: number;
		/**
		 * Quiet period (ms) after a chat's last activity before the manager may run
		 * an idle memory-consolidation pass on it. Default 1800000 (30 min).
		 */
		factConsolidationQuietMs: number;
		/**
		 * Max candidate facts individually verified in the consolidation
		 * interrogation (caps its per-fact question loop). Default 8.
		 */
		verifyLimit: number;
		/**
		 * A newly-arrived interlocutor message older than this (by its true send
		 * time) is treated as backlog: recorded for context but not engaged as a live
		 * reply cycle, so a redelivered old conversation never "wakes". Default
		 * 120000 (2 min).
		 */
		liveFreshnessMs: number;
		responseMode: "smart" | "active" | "mention";
		markRead: boolean;
		throttleMs: number;
		/** Prefix prepended to each outgoing business message ("" = none). */
		labeler: string;
		/**
		 * Wake-words (case-insensitive). A message containing one jumps the owner-reply
		 * window straight into processing (the model still decides whether it is a
		 * direct question worth answering). Empty = disabled. Default `["llm"]`.
		 */
		mentionWords: string[];
		instructionFiles: string[];
		/** Required template for the first message from a new interlocutor. */
		firstMessageTemplate?: string;
		/**
		 * Re-greet a chat that resumes after this much silence (ms) from anyone's
		 * last message. Default 86400000 (24h); `0` disables re-greeting entirely.
		 */
		reopenAfterMs: number;
		/** Optional override file for the re-opening greeting template. */
		reopenTemplate?: string;
		/**
		 * How many times a drafted reply may be re-considered when new interlocutor
		 * messages keep arriving mid-turn before it is sent as-is. Caps the revise
		 * loop so a rapid sender cannot defer a reply forever. Default 2; `0` sends
		 * the draft immediately without any re-read.
		 */
		reviseThreshold: number;
		/**
		 * Mirror every manager turn (thinking, tool calls, decision) to the owner's
		 * private chat with the bot — the bot account is idle in mode 2, so it doubles
		 * as an observability feed. Default false (opt-in; it is chatty in observer).
		 */
		debugFeed: boolean;
		/**
		 * The Owner's display name, surfaced to the model so it can introduce itself
		 * as "{name}'s assistant" on first contact. Optional; when unset the model
		 * refers to "the owner" generically.
		 */
		ownerName?: string;
		/**
		 * Drop a reply the model itself marked as chatter/acknowledgement or as not
		 * needing an answer, UNLESS the interlocutor addressed the bot directly (by
		 * category or a wake-word). Curbs a weak local model that over-replies to
		 * banter. Default true.
		 */
		strictReplyGuard: boolean;
		subMode: ManagerSubMode;
		observer: {
			interlocutorInstructionFile?: string;
			ownerInstructionFile?: string;
		};
		takeover: {
			instructionFile?: string;
		};
	};
	files: {
		maxBytes: number;
		/**
		 * Directory where files a user sends to the bot (mode 1) are saved. Absolute
		 * or `~`-relative. When unset, files are saved into the directory Pi runs in
		 * (its current working directory).
		 */
		downloadDir?: string;
	};
}

export const DEFAULT_SETTINGS: TelegramSettings = {
	assistant: { rendering: "rich", draftPreviews: true, toolActivity: true },
	connectionCheck: { enabled: true, intervalMs: 600_000, maxRetries: 3 },
	instructionFiles: [],
	connect: { instructionFiles: [] },
	manager: {
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		catchUpWindowMs: 36_000_000,
		allowedTools: [],
		media: { images: true, documents: false },
		rememberMessages: 20,
		factsLimit: 20,
		factConsolidationQuietMs: 1_800_000,
		verifyLimit: 8,
		liveFreshnessMs: 120_000,
		reopenAfterMs: 86_400_000,
		reviseThreshold: 2,
		debugFeed: false,
		strictReplyGuard: true,
		responseMode: "smart",
		markRead: true,
		throttleMs: 0,
		labeler: "LLM agent 🤖:",
		mentionWords: ["llm"],
		instructionFiles: [],
		subMode: "observer",
		observer: {},
		takeover: {},
	},
	files: { maxBytes: 52_428_800 },
};

// --- field validators (throw TypeError with a path on a wrong type) ---

function asString(value: unknown, path: string, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	throw new TypeError(`${path} must be a string`);
}

function asOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw new TypeError(`${path} must be a string`);
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	throw new TypeError(`${path} must be a boolean`);
}

function asNonNegativeInt(
	value: unknown,
	path: string,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	throw new TypeError(`${path} must be a non-negative integer`);
}

function asPositiveInt(value: unknown, path: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	throw new TypeError(`${path} must be a positive integer`);
}

function asStringArray(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value as string[];
	}
	throw new TypeError(`${path} must be an array of strings`);
}

function asEnum<T extends string>(
	value: unknown,
	path: string,
	allowed: readonly T[],
	fallback: T,
): T {
	if (value === undefined) return fallback;
	if (
		typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
	) {
		return value as T;
	}
	throw new TypeError(`${path} must be one of: ${allowed.join(", ")}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new TypeError(`${path} must be an object`);
}

const KNOWN_TOP_LEVEL = new Set([
	"botToken",
	"allowedUserId",
	"timezone",
	"assistant",
	"connectionCheck",
	"instructionFiles",
	"connect",
	"manager",
	"files",
]);

/**
 * Validate + normalize raw JSON into {@link TelegramSettings}, layering over
 * {@link DEFAULT_SETTINGS}. Appends human-readable notes for unknown top-level
 * keys to `warnings`.
 */
export function normalizeSettings(
	raw: unknown,
	warnings: string[] = [],
): TelegramSettings {
	const root = asRecord(raw, "settings");
	for (const key of Object.keys(root)) {
		if (!KNOWN_TOP_LEVEL.has(key)) {
			warnings.push(`Unknown setting "${key}" ignored`);
		}
	}

	const d = DEFAULT_SETTINGS;
	const assistant = asRecord(root.assistant, "assistant");
	const connectionCheck = asRecord(root.connectionCheck, "connectionCheck");
	const connect = asRecord(root.connect, "connect");
	const manager = asRecord(root.manager, "manager");
	const observer = asRecord(manager.observer, "manager.observer");
	const takeover = asRecord(manager.takeover, "manager.takeover");
	const media = asRecord(manager.media, "manager.media");
	const files = asRecord(root.files, "files");

	const allowedUserId =
		root.allowedUserId === undefined
			? undefined
			: typeof root.allowedUserId === "number"
				? root.allowedUserId
				: (() => {
						throw new TypeError("allowedUserId must be a number");
					})();

	return {
		botToken: asOptionalString(root.botToken, "botToken"),
		allowedUserId,
		timezone: asOptionalString(root.timezone, "timezone"),
		assistant: {
			rendering: asEnum(
				assistant.rendering,
				"assistant.rendering",
				["rich", "html"] as const,
				d.assistant.rendering,
			),
			draftPreviews: asBoolean(
				assistant.draftPreviews,
				"assistant.draftPreviews",
				d.assistant.draftPreviews,
			),
			toolActivity: asBoolean(
				assistant.toolActivity,
				"assistant.toolActivity",
				d.assistant.toolActivity,
			),
		},
		connectionCheck: {
			enabled: asBoolean(
				connectionCheck.enabled,
				"connectionCheck.enabled",
				d.connectionCheck.enabled,
			),
			intervalMs: asNonNegativeInt(
				connectionCheck.intervalMs,
				"connectionCheck.intervalMs",
				d.connectionCheck.intervalMs,
			),
			maxRetries: asPositiveInt(
				connectionCheck.maxRetries,
				"connectionCheck.maxRetries",
				d.connectionCheck.maxRetries,
			),
		},
		instructionFiles: asStringArray(root.instructionFiles, "instructionFiles"),
		connect: {
			instructionFiles: asStringArray(
				connect.instructionFiles,
				"connect.instructionFiles",
			),
		},
		manager: {
			continueWindowMs: asPositiveInt(
				manager.continueWindowMs,
				"manager.continueWindowMs",
				d.manager.continueWindowMs,
			),
			ownerReplyWindowMs: asPositiveInt(
				manager.ownerReplyWindowMs,
				"manager.ownerReplyWindowMs",
				d.manager.ownerReplyWindowMs,
			),
			catchUpWindowMs: asPositiveInt(
				manager.catchUpWindowMs,
				"manager.catchUpWindowMs",
				d.manager.catchUpWindowMs,
			),
			allowedTools: asStringArray(manager.allowedTools, "manager.allowedTools"),
			media: {
				images: asBoolean(
					media.images,
					"manager.media.images",
					d.manager.media.images,
				),
				documents: asBoolean(
					media.documents,
					"manager.media.documents",
					d.manager.media.documents,
				),
			},
			rememberMessages: asPositiveInt(
				manager.rememberMessages,
				"manager.rememberMessages",
				d.manager.rememberMessages,
			),
			factsLimit: asPositiveInt(
				manager.factsLimit,
				"manager.factsLimit",
				d.manager.factsLimit,
			),
			factConsolidationQuietMs: asPositiveInt(
				manager.factConsolidationQuietMs,
				"manager.factConsolidationQuietMs",
				d.manager.factConsolidationQuietMs,
			),
			verifyLimit: asPositiveInt(
				manager.verifyLimit,
				"manager.verifyLimit",
				d.manager.verifyLimit,
			),
			liveFreshnessMs: asPositiveInt(
				manager.liveFreshnessMs,
				"manager.liveFreshnessMs",
				d.manager.liveFreshnessMs,
			),
			responseMode: asEnum(
				manager.responseMode,
				"manager.responseMode",
				["smart", "active", "mention"] as const,
				d.manager.responseMode,
			),
			markRead: asBoolean(
				manager.markRead,
				"manager.markRead",
				d.manager.markRead,
			),
			throttleMs: asNonNegativeInt(
				manager.throttleMs,
				"manager.throttleMs",
				d.manager.throttleMs,
			),
			labeler: asString(manager.labeler, "manager.labeler", d.manager.labeler),
			// Absent → the default wake-word; an explicit array (incl. []) is honoured,
			// so `[]` disables the feature.
			mentionWords:
				manager.mentionWords === undefined
					? [...d.manager.mentionWords]
					: asStringArray(manager.mentionWords, "manager.mentionWords"),
			instructionFiles: asStringArray(
				manager.instructionFiles,
				"manager.instructionFiles",
			),
			firstMessageTemplate: asOptionalString(
				manager.firstMessageTemplate,
				"manager.firstMessageTemplate",
			),
			reopenAfterMs: asNonNegativeInt(
				manager.reopenAfterMs,
				"manager.reopenAfterMs",
				d.manager.reopenAfterMs,
			),
			reopenTemplate: asOptionalString(
				manager.reopenTemplate,
				"manager.reopenTemplate",
			),
			reviseThreshold: asNonNegativeInt(
				manager.reviseThreshold,
				"manager.reviseThreshold",
				d.manager.reviseThreshold,
			),
			debugFeed: asBoolean(
				manager.debugFeed,
				"manager.debugFeed",
				d.manager.debugFeed,
			),
			ownerName: asOptionalString(manager.ownerName, "manager.ownerName"),
			strictReplyGuard: asBoolean(
				manager.strictReplyGuard,
				"manager.strictReplyGuard",
				d.manager.strictReplyGuard,
			),
			subMode: asEnum(
				manager.subMode,
				"manager.subMode",
				["observer", "takeover"] as const,
				d.manager.subMode,
			),
			observer: {
				interlocutorInstructionFile: asOptionalString(
					observer.interlocutorInstructionFile,
					"manager.observer.interlocutorInstructionFile",
				),
				ownerInstructionFile: asOptionalString(
					observer.ownerInstructionFile,
					"manager.observer.ownerInstructionFile",
				),
			},
			takeover: {
				instructionFile: asOptionalString(
					takeover.instructionFile,
					"manager.takeover.instructionFile",
				),
			},
		},
		files: {
			maxBytes: asPositiveInt(
				files.maxBytes,
				"files.maxBytes",
				d.files.maxBytes,
			),
			downloadDir: asOptionalString(files.downloadDir, "files.downloadDir"),
		},
	};
}
