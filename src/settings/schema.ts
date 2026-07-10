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
	assistant: {
		rendering: "rich" | "html";
		draftPreviews: boolean;
		/** Mirror each agent tool call to Telegram as a collapsible block (mode 1). */
		toolActivity: boolean;
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
		/** Last-N messages remembered per chat. */
		rememberMessages: number;
		responseMode: "smart" | "active" | "mention";
		markRead: boolean;
		throttleMs: number;
		/** Prefix prepended to each outgoing business message ("" = none). */
		labeler: string;
		instructionFiles: string[];
		/** Required template for the first message from a new interlocutor. */
		firstMessageTemplate?: string;
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
	};
}

export const DEFAULT_SETTINGS: TelegramSettings = {
	assistant: { rendering: "rich", draftPreviews: true, toolActivity: true },
	instructionFiles: [],
	connect: { instructionFiles: [] },
	manager: {
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		rememberMessages: 20,
		responseMode: "smart",
		markRead: true,
		throttleMs: 0,
		labeler: "LLM agent:",
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
	"assistant",
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
	const connect = asRecord(root.connect, "connect");
	const manager = asRecord(root.manager, "manager");
	const observer = asRecord(manager.observer, "manager.observer");
	const takeover = asRecord(manager.takeover, "manager.takeover");
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
			rememberMessages: asPositiveInt(
				manager.rememberMessages,
				"manager.rememberMessages",
				d.manager.rememberMessages,
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
			instructionFiles: asStringArray(
				manager.instructionFiles,
				"manager.instructionFiles",
			),
			firstMessageTemplate: asOptionalString(
				manager.firstMessageTemplate,
				"manager.firstMessageTemplate",
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
		},
	};
}
