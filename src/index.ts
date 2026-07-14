/**
 * pi-telegram-manager — composition root.
 *
 * The single Pi extension entrypoint (declared in package.json under
 * `pi.extensions`). It wires the tested domain pieces to the live Pi/grammY
 * runtime: builds shared infra (fs, paths, lifecycle, tool visibility), gates
 * the telegram tools, and registers the mode commands and agent-lifecycle
 * handlers.
 *
 * Mode 1 (terminal continuation) is wired here through `ConnectController`;
 * mode 2 (business manager) through `ManagerController`. The two are mutually
 * exclusive (the lifecycle singleton enforces it).
 *
 * `isIdle` is tracked with a local `busy` flag flipped by agent_start/agent_end,
 * because Telegram updates arrive from the polling loop outside any Pi event
 * context; `sendUserMessage` is used from the top-level `pi` for the same
 * reason.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BusinessConnection,
	InlineKeyboardMarkup,
	Message,
} from "@grammyjs/types";
import {
	COMMANDS,
	COMPLIANCE_LINKS,
	COMPLIANCE_NOTICE,
	SETUP_GUIDE_URL,
	TELEGRAM_BOT_COMMANDS,
	TELEGRAM_PUBLIC_COMMANDS,
} from "./constants";
import { AbortRegistry } from "./core/abort";
import {
	ABOUT_CALLS_PER_TURN,
	ABOUT_TOOL_NAMES,
	createAboutTools,
} from "./core/about";
import { createAttachmentTools, TELEGRAM_TOOL_NAMES } from "./core/attachments";
import { runFocusedCompaction } from "./core/compaction-run";
import { withSystemBlock } from "./core/connect-context";
import { watchdogVerdict } from "./core/connection-watchdog";
import {
	type ContextSnapshot,
	type MeasurableMessage,
	type ContextSource as MeasuredSource,
	measureContext,
} from "./core/context-measure";
import { ContextReset } from "./core/context-reset";
import { formatClock, formatNowLine } from "./core/datetime";
import { readInstructionFiles } from "./core/instructions";
import { createLifecycleController, pidIsAlive } from "./core/lifecycle";
import {
	classifyInputSource,
	shouldMirrorToTelegram,
} from "./core/prompt-origin";
import { createSerialLane } from "./core/serial-lane";
import { renderSettingsReport } from "./core/settings-report";
import {
	fullOutputPath,
	planAttachment,
	toolOutputFileName,
} from "./core/tool-output-file";
import { TurnSignal } from "./core/turn-signal";
import type { TurnSavedFile } from "./core/turns";
import { resolveUserDir } from "./core/user-path";
import {
	loadConnectInstructions,
	loadManagerInstructions,
	verifyBundledInstructions,
} from "./instructions/builtin";
import {
	compactedCard,
	compactingCard,
	compactionFailedCard,
} from "./modes/connect/compaction-cards";
import {
	type CompactionMemory,
	type ContextReportInput,
	renderContextCard,
	renderContextText,
} from "./modes/connect/context-card";
import {
	ConnectController,
	isReadOnlyBridgeCommand,
	MIRROR_URL,
	REPO_URL,
} from "./modes/connect/controller";
import { bullet, card, note } from "./modes/connect/format";
import {
	extractText,
	lastAssistantReply,
	lastAssistantThinking,
	type PromptContent,
	parseSlashCommand,
} from "./modes/connect/messages";
import {
	renderStatusCard,
	renderStatusText,
	type StatusInput,
	type StatusMode,
} from "./modes/connect/status-card";
import {
	lastInterlocutorName,
	lastInterlocutorUserId,
	selectCatchUpChats,
} from "./modes/manager/catchup";
import {
	type ConnectionAlert,
	connectionAlerts,
} from "./modes/manager/connection-health";
import { toRebuiltMessages } from "./modes/manager/context-isolation";
import {
	ManagerController,
	type ManagerTurnLog,
} from "./modes/manager/controller";
import {
	buildManagerFeed,
	buildManagerNotice,
	isEmptyFeedTurn,
	type ManagerNoticeLevel,
	type ManagerToolCall,
} from "./modes/manager/debug-feed";
import {
	createDraftResolveTool,
	createManagerTools,
	type DecisionSink,
	type DraftResolutionSink,
	type FactSink,
	MANAGER_RESOLVE_TOOL_NAME,
	MANAGER_TOOL_NAMES,
} from "./modes/manager/decision";
import {
	createInterrogationTools,
	INTERROGATION_TOOL_NAMES,
	type ProbeSink,
} from "./modes/manager/interrogation";
import { withLabelerMention } from "./modes/manager/mention";
import {
	stripTelegramTurns,
	stripTelegramTurnsFromCompaction,
	tagTelegramPrompt,
} from "./modes/manager/mixed-context";
import {
	managerGuardActive,
	managerHoldsSession,
	mixedContextSource,
} from "./modes/manager/polarity";
import { formatManagerReplyHtmlChunks } from "./modes/manager/reply-format";
import { resolveTelegramPaths } from "./pi/agent-dir";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";
import { compact } from "./pi/sdk";
import { createToolMatcher, type ToolMatcher } from "./pi/tool-allow";
import {
	RESOLVE_DRAFT_END_TURN_HINT,
	registerToolGuard,
} from "./pi/tool-guard";
import {
	createToolVisibility,
	registerToolVisibility,
} from "./pi/tool-visibility";
import { loadSettings } from "./settings/manager";
import type { TelegramSettings } from "./settings/schema";
import { resolveSecret } from "./settings/secret";
import {
	type BusinessStore,
	createBusinessStore,
} from "./storage/business-store";
import {
	type ChatMessageRecord,
	type ChatStore,
	createChatStore,
} from "./storage/chat-store";
import { createConsolidationQueue } from "./storage/consolidation-queue";
import { createContactStore } from "./storage/contact-store";
import { createNodeFs } from "./storage/fs";
import { readJsonIfExists, writeJson } from "./storage/json";
import { migrateMemory } from "./storage/memory-migration";
import { createSentRegistry } from "./storage/sent-registry";
import { createSingletonStore } from "./storage/singleton-store";
import {
	fetchBytesFromUrl,
	fileBaseUrl,
	TelegramClient,
} from "./telegram/client";
import { formatBytes, resolveSaveName } from "./telegram/file-store";
import {
	describeAttachments,
	type FileApi,
	isImage,
	loadInlineImages,
	MediaDownloader,
} from "./telegram/media";
import { type OutboundApi, OutboundSender } from "./telegram/outbound";
import { extractProfileFromUser } from "./telegram/profile";
import {
	buildSwitchKeyboard,
	isStopCommand,
	isSwitchCommand,
	type PanelMode,
	parseSwitchData,
	type SwitchTarget,
	switchLabel,
	switchPanelText,
} from "./telegram/switch-panel";
import { ThinkingLog } from "./telegram/thinking-log";
import {
	DEFAULT_MAX_RESULT_CHARS,
	toolActivityHint,
	unwrapToolResult,
} from "./telegram/tool-activity";
import {
	placeOfOwnerMessage,
	TopicRouter,
	type TopicsApi,
} from "./telegram/topics";
import type { TelegramEvent } from "./telegram/updates";
import { fitLine, fitLines, terminalWidth } from "./ui/fit";
import { managerBannerLines } from "./ui/manager-banner";

/**
 * The narrow slice of the grammY raw api the `/switch` panel and the pinned
 * mode indicator need: send a message (optionally with an inline keyboard),
 * acknowledge a button press, edit a panel's keyboard, edit a message's text, and
 * pin. Cast from `client.api` (the same pattern as `OutboundApi`), so no extra
 * `TelegramClient` methods are required.
 */
interface ControlApi {
	sendMessage(payload: {
		chat_id: number;
		text: string;
		/** The topic this control message belongs to (owner DM with topics on). */
		message_thread_id?: number;
		reply_markup?: InlineKeyboardMarkup;
		/** Control the URL preview card (e.g. disable it for a help message). */
		link_preview_options?: { is_disabled?: boolean; url?: string };
	}): Promise<{ message_id: number }>;
	answerCallbackQuery(payload: {
		callback_query_id: string;
		text?: string;
	}): Promise<unknown>;
	editMessageReplyMarkup(payload: {
		chat_id: number;
		message_id: number;
		reply_markup?: InlineKeyboardMarkup;
	}): Promise<unknown>;
	pinChatMessage(payload: {
		chat_id: number;
		message_id: number;
		disable_notification?: boolean;
	}): Promise<unknown>;
	/** Removes the previous mode pin, so only one is ever in the chat. */
	deleteMessage(payload: {
		chat_id: number;
		message_id: number;
	}): Promise<unknown>;
	/** Copies a message the owner typed elsewhere into the personal topic. */
	forwardMessage(payload: {
		chat_id: number;
		message_thread_id?: number;
		from_chat_id: number;
		message_id: number;
	}): Promise<unknown>;
}

/** The `setMyCommands` surface, narrowed to what the menus need. */
interface CommandMenuApi {
	setMyCommands(payload: {
		commands: readonly { command: string; description: string }[];
		scope?: { type: "chat"; chat_id: number };
	}): Promise<unknown>;
}

/**
 * Publish the two command menus. The owner's chat gets the control commands; the
 * default scope — everyone else who opens this bot — gets only `/start`.
 *
 * This is presentation, not permission: every control command is already refused
 * to anyone but `allowedUserId`. But an unscoped menu ADVERTISED "Stop the bot
 * entirely" to strangers, which is both a confusing button and a description of a
 * machine that is none of their business. Best-effort: a menu that fails to
 * publish costs nobody anything.
 */
function publishCommandMenus(api: unknown, ownerChatId: number): void {
	const menu = api as CommandMenuApi;
	void menu
		.setMyCommands({ commands: TELEGRAM_PUBLIC_COMMANDS })
		.catch(() => {});
	void menu
		.setMyCommands({
			commands: TELEGRAM_BOT_COMMANDS,
			scope: { type: "chat", chat_id: ownerChatId },
		})
		.catch(() => {});
}

/**
 * Sent to the owner's DM when the topics could not be set up. Threaded Mode is a
 * setup step, not a nicety: without it the manager feed, the notices and your own
 * conversation share one stream, and the DM becomes unusable as either.
 */
const TOPICS_SETUP_NOTICE = [
	"⚠️ Threaded Mode is OFF for this bot, so this DM stays one flat stream:",
	"your conversation, the manager feed and every notice mixed together.",
	"",
	"Turn it on: @BotFather → open its Mini App (the menu button next to the",
	"message field) → pick this bot → Thread Settings → Threaded Mode.",
	"It is NOT in the classic /mybots → Bot Settings keyboard.",
	"",
	`Setup steps: ${SETUP_GUIDE_URL}`,
	"",
	"Then restart the mode and the bot creates the `personal` and `manager`",
	"topics itself. Prefer one flat DM? Set topics.enabled: false and this",
	"notice stops.",
].join("\n");

/**
 * Sent when Secretary Mode is off for the bot: the manager cannot receive a single
 * business chat, so it would just sit there looking broken.
 */
const SECRETARY_SETUP_NOTICE = [
	"⛔ Secretary Mode is OFF for this bot, so it cannot be connected to your",
	"account — the manager will never receive a chat.",
	"",
	"Turn it on: @BotFather → /mybots → this bot → Bot Settings →",
	"Secretary Mode (formerly Business Mode) → Turn on.",
	"",
	`Setup steps: ${SETUP_GUIDE_URL}`,
].join("\n");

/**
 * Sent when the bot IS connected but was not granted the right to reply: it reads
 * every chat and can answer none of them — the silence looks exactly like a bug.
 */
const REPLY_RIGHT_NOTICE = [
	"⛔ This bot is connected to your account but is NOT allowed to reply.",
	"It can read your chats and answer nothing.",
	"",
	"Fix it in Telegram: Settings → Business / Secretary → Chatbots →",
	"this bot → allow it to reply to messages.",
	"",
	`Setup steps: ${SETUP_GUIDE_URL}`,
].join("\n");

/**
 * The rights of a live connection are changed in the Telegram app, and Telegram
 * reports it once. Without these notices the manager just goes quiet: revoking
 * `can_reply` mid-run leaves it reading every chat and failing every send, which
 * from the outside is indistinguishable from a bot that decided to say nothing.
 */
const CONNECTION_ALERT_NOTICES: Record<ConnectionAlert, string> = {
	disabled: [
		"⛔ The Secretary connection to this bot was just switched OFF.",
		"It no longer receives your chats and cannot answer them.",
		"",
		"Turn it back on: Telegram → Settings → Business / Secretary → Chatbots.",
	].join("\n"),
	enabled:
		"✅ The Secretary connection is back on — the manager is listening again.",
	reply_right_lost: [
		"⛔ This bot just LOST the right to reply on your behalf.",
		"It still reads every managed chat and can answer none of them.",
		"",
		"Restore it: Telegram → Settings → Business / Secretary → Chatbots →",
		"this bot → allow it to reply to messages.",
	].join("\n"),
	reply_right_restored:
		"✅ The right to reply is back — the manager can answer again.",
};

/**
 * Sent when nothing has proved the Secretary connection yet. It cannot be checked
 * on demand: Telegram delivers `business_connection` only when the connection
 * CHANGES, and there is no API to list connections — so a bot connected before its
 * first run has nothing to show for it until a message arrives. Hence the careful
 * wording: this says what we have SEEN, not what is true.
 */
const NOT_CONNECTED_NOTICE = [
	"ℹ️ No Secretary connection seen yet — no traffic and no connection update",
	"since this mode started. If the bot IS already connected, ignore this: it",
	"clears itself as soon as any message arrives in a managed chat.",
	"",
	"If it is not connected: Telegram → Settings → Business / Secretary →",
	"Chatbots → add this bot and pick which chats it may access (and let it reply).",
	"",
	`Setup steps: ${SETUP_GUIDE_URL}`,
].join("\n");

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
/** How long a single connection-watchdog probe (getMe) may take before it counts as failed. */
const CONNECTION_PROBE_TIMEOUT_MS = 15_000;
const TYPING_REFRESH_MS = 4_000;
const DRAFT_THROTTLE_MS = 700;
/**
 * The trace is re-sent on this beat. Two clocks demand it: a streaming draft
 * expires ~30s after its last update (so a long tool would leave the chat blank
 * exactly when the agent is busiest), and the running step counts its own elapsed
 * seconds, which would otherwise sit frozen. Re-sending the same draft id animates
 * in place, so this is invisible — the number just ticks.
 */
const THINKING_REFRESH_MS = 3_000;
/**
 * How long an UNCHANGED trace may sit before it is re-sent anyway. It only has to
 * beat the draft's ~30s expiry; until then, repeating identical content is traffic
 * that buys nothing (Telegram's guidance is one message per second per chat, so
 * neither rate is anywhere near a limit — this is just not being wasteful).
 */
const THINKING_KEEPALIVE_MS = 15_000;
/**
 * What the draft says while a finished reply waits for the tool output ahead of it to
 * finish uploading — the one moment the agent is done but the chat is not.
 */
const SENDING_OUTPUT_HEADLINE = "📎 Sending the tool output…";
/**
 * How long the queue pump waits for the session before giving up on this attempt.
 *
 * Generous — a real turn can take minutes on a local model, and a message that waits
 * is better than a message shoved into the session's own queue (from where the next
 * abort dumps it into the terminal editor). What it must never be is unbounded: an
 * unbounded wait on a session that never settles is how the bot went silent for good.
 */
const IDLE_WAIT_MS = 120_000;
/** How long /esc gives the session to actually stop before calling it stuck. */
const ESC_SETTLE_MS = 3_000;
/** How long a session may refuse to go idle before the owner is told it is wedged. */
const STUCK_WARN_AFTER_MS = 120_000;
/** Retry the queue on this beat, so a message never waits on an event that never comes. */
const QUEUE_PUMP_MS = 15_000;
/**
 * How long a delivered prompt has to become a turn before we call the hand-off failed.
 *
 * A prompt Pi accepted starts its turn at once, so this is generous by a wide margin —
 * it exists to catch the hand-off that was silently thrown away, not to race a slow one.
 */
const TURN_START_WAIT_MS = 15_000;
/** …unless a compaction is running ahead of the turn. Then we wait it out, up to this. */
const TURN_START_MAX_WAIT_MS = 300_000;
/** A compaction that has not reported back in this long is not running any more. */
const COMPACTION_MAX_MS = 300_000;
const MANAGER_TICK_MS = 5_000;
const STATUS_KEY = "telegram";

/**
 * How many un-answered messages typed outside the personal topic are remembered. A
 * turn claims its own, so this only bounds the ones no turn ever came for (a message
 * sent while the bot was busy elsewhere, an aborted turn).
 */
const MAX_STRAY_MESSAGES = 50;
const MANAGER_BANNER_KEY = "telegram-manager-banner";

// Every tool the manager may use in the telegram-sandbox: the reply/memory tools,
// the consolidation interrogation probes, and the resolve-draft tool (visible only
// on a revise turn — see the matcher wrapper in startManager).
/** Bundled `about` pages ship beside the source, like the instruction files. */
const ABOUT_DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "about");

const MANAGER_TOOLS = [
	...MANAGER_TOOL_NAMES,
	...INTERROGATION_TOOL_NAMES,
	MANAGER_RESOLVE_TOOL_NAME,
	// `about` is safe inside the sandbox: it reads bundled pages by a fixed key, takes
	// no path, touches no file the model can name — and refuses the owner's live
	// configuration on a manager turn. A stranger asking "what are you?" deserves a
	// true answer; a stranger asking "how are you set up?" gets nothing.
	...ABOUT_TOOL_NAMES,
];

// Plain-text /help for the owner DM while the manager/mixed mode is active (the
// control API sends plain text, so raw URLs auto-link instead of Markdown ones).
const MANAGER_HELP_TEXT = [
	"🧭 Pi Telegram bridge",
	"",
	"/switch — change mode (manager / personal / mixed)",
	"/status — model, context, working directory, queue",
	"/context — what I am carrying, and what filled it up",
	"/esc — cancel whatever the agent is doing right now",
	"/stop — stop the bot entirely",
	"/start — privacy & terms",
	"/help — show this help",
	"",
	"/clear and /compact belong to personal and mixed mode: here I build the context fresh for each conversation, so there is no history to clear or compact.",
	"",
	"⚠️ Privacy & terms — read and follow these before using the bot:",
	`• ${COMPLIANCE_LINKS.botTerms}`,
	`• ${COMPLIANCE_LINKS.privacy}`,
	`• ${COMPLIANCE_LINKS.business}`,
	"",
	"Terminal commands (/telegram-personal, -manager, -mixed) also run in Pi.",
	`This bot runs pi-telegram-manager: ${REPO_URL}`,
	`Mirror: ${MIRROR_URL}`,
].join("\n");

export default function piTelegramManagerExtension(pi: ExtensionAPI): void {
	const fs = createNodeFs();
	const paths = resolveTelegramPaths();
	const singletonStore = createSingletonStore(fs, paths.singletonPath);
	const contactStore = createContactStore(fs, paths);
	const lifecycle = createLifecycleController({
		store: singletonStore,
		now: () => Date.now(),
		ownPid: process.pid,
		isPidAlive: pidIsAlive,
		heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
	});
	const abort = new AbortRegistry();
	const contextReset = new ContextReset();
	const visibility = createToolVisibility(pi, {
		connect: [...TELEGRAM_TOOL_NAMES, ...ABOUT_TOOL_NAMES],
		manager: MANAGER_TOOLS,
	});
	registerToolVisibility(pi, visibility);
	// Runtime backstop for the telegram-sandbox: block any tool the manager's
	// allowlist does not permit, even if it slipped past the visibility gate.
	registerToolGuard(pi, {
		// The sandbox is enforced whenever the manager holds the session — except in
		// mixed mode's coding polarity, where the owner is coding and needs full tools.
		isActive: () => managerGuardActive(manager !== null, mixedActive, polarity),
		matcher: () => managerMatcher,
		// On a revise turn the decision tools are blocked, so the steer must point at
		// the one tool that can end it — otherwise a blocked manager_reply answers
		// "call manager_reply", and the model spins until the turn is wasted.
		endTurnHint: () =>
			manager?.isReviseTurn() ? RESOLVE_DRAFT_END_TURN_HINT : undefined,
	});

	/**
	 * Prepend the connect system instructions so the agent knows it is bridged to
	 * Telegram (files saved to disk, telegram_attach to send back), for Personal mode
	 * and for mixed's coding polarity alike. Nothing is appended — see
	 * `core/connect-context.ts` for why that sentence is the important one.
	 */
	const withConnectBlock = <T>(messages: readonly T[]): unknown[] =>
		connect ? withSystemBlock(messages, connectSystemBlock) : [...messages];

	/**
	 * The exact array we are about to hand the model, measured on the way out — this
	 * is the only place it exists, and the only place that knows what we changed. It
	 * is what `/context` reports. See `core/context-measure.ts`.
	 */
	const measured = <T>(
		source: MeasuredSource,
		messages: readonly T[],
	): { messages: readonly T[] } => {
		lastContext = measureContext(
			source,
			messages as readonly MeasurableMessage[],
			Date.now(),
		);
		return { messages };
	};

	// Rebuild the LLM context per mode: the manager replaces it with the active
	// chat's isolated history (mode 2); mode 1 applies the /clear boundary. No
	// mode / no boundary → leave the context untouched.
	pi.on("context", async (event) => {
		const source = mixedContextSource(manager !== null, mixedActive, polarity);
		// Coding polarity (mixed): the owner's real session messages, with the
		// manager's Telegram turns filtered out so they never pollute the thread. The
		// owner may be driving this turn from the `chat` topic, so the bridge's system
		// block belongs here exactly as it does in Personal mode.
		if (source === "coding-filtered") {
			const stripped = stripTelegramTurns(event.messages);
			return measured(
				"mixed-coding",
				withConnectBlock(contextReset.apply(stripped) ?? stripped),
			) as never;
		}
		// Manager / mixed-telegram: replace context with the active chat's isolated
		// history so the model sees only that one conversation.
		if (source === "manager-chat" && manager) {
			const isolated = await manager.buildContextForActive();
			if (!isolated) return {};
			return measured(
				"manager-chat",
				toRebuiltMessages(isolated, Date.now()),
			) as never;
		}
		const filtered = contextReset.apply(event.messages);
		// Mode 1: the owner's thread, with the bridge's system block.
		if (connect && connectSystemBlock) {
			return measured(
				"personal",
				withConnectBlock(filtered ?? event.messages),
			) as never;
		}
		return filtered ? { messages: filtered } : {};
	});

	// Live connect-mode runtime (null when inactive).
	let connect: ConnectController | null = null;
	let client: TelegramClient | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	// Retries the connect queue on a beat — see where it is armed.
	let queuePump: ReturnType<typeof setInterval> | null = null;
	// When the running mode started, for the "up for" line of /status. 0 = nothing running.
	let modeStartedAt = 0;
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let busy = false;
	// Whether the agent run in flight belongs to the owner's own thread (personal
	// mode always; mixed only in the coding polarity). Set at agent_start — see there.
	let ownerRun = false;
	// Whether any assistant message of the current run was already mirrored to
	// Telegram (message_end), so agent_end does not repeat the last one.
	let mirroredThisRun = false;
	// Mirror agent tool calls to Telegram as collapsible blocks (mode 1).
	let toolActivityEnabled = false;
	// Byte cap for attaching a tool's own full-output file; 0 = never attach.
	let toolOutputMaxBytes = 0;
	// Where we write a full output we saved ourselves (owner-configurable).
	let toolOutputDir = paths.toolOutputDir;
	// Stream the assistant reply as an animated draft while it generates.
	let draftPreviewsEnabled = false;
	// The animated trace — beta, and off unless the owner asked for it.
	let thinkingEnabled = false;
	// The turn's live trace — the steps taken so far and the one running — shown in
	// the draft until the first token of the reply arrives.
	const thinkingLog = new ThinkingLog();
	// Whether a trace is currently in the draft (so a finished turn knows to erase it).
	let thinkingUp = false;
	let thinkingTimer: ReturnType<typeof setInterval> | null = null;
	// The last trace actually sent, so an unchanged one is not re-sent every tick.
	let lastThinkingHtml = "";
	let lastThinkingAt = 0;
	let draftText = "";
	let lastDraftAt = 0;
	// Everything the bot puts in the chat during a turn goes through this lane, so it
	// lands in the order the turn actually happened: card, its output, the next card,
	// the answer. Pi emits events fire-and-forget, so without it a slow send is simply
	// overtaken by the fast ones behind it — which is how a tool's full-output file
	// ended up UNDER the final answer, quoting a card from further up the chat.
	const chatLane = createSerialLane();
	// Mode-1 system instructions (bundled connect.md + user override), injected at
	// the head of the context while connect is active; null when inactive.
	let connectSystemBlock: string | null = null;
	// The last context handed to the model, and the last compaction of this session —
	// everything `/context` reports. Null until the first turn.
	let lastContext: ContextSnapshot | null = null;
	let lastCompaction: CompactionMemory | null = null;
	// Fires on `agent_start`. It is how a hand-off is confirmed — see `deliverPrompt`.
	const turnStarted = new TurnSignal();
	// One hand-off at a time (see `deliverPrompt`).
	let deliveryInFlight = false;
	// When the running compaction began; 0 = none. A compaction runs BEFORE the turn it
	// delays (Pi checks for one inside `prompt()`), so a prompt waiting behind one has
	// not failed — and on a local model it can take minutes. The stamp expires on its
	// own, so a compaction that never reports back cannot wedge the delivery path.
	let compactingSince = 0;
	const compactionInFlight = (): boolean =>
		compactingSince > 0 && Date.now() - compactingSince < COMPACTION_MAX_MS;

	// Topics in the owner's bot DM (chat + log), shared by both modes; null until a
	// mode starts, and inert whenever the bot has no topic mode (plain DM as before).
	let topics: TopicRouter | null = null;

	// Live manager-mode runtime (null when inactive).
	let manager: ManagerController | null = null;
	// The active telegram-sandbox allowlist; null while the manager is inactive.
	let managerMatcher: ToolMatcher | null = null;
	// Tool calls made during the current manager turn, gathered for the debug feed
	// (reset each agent_start, drained on agent_end).
	let managerTurnTools: ManagerToolCall[] = [];
	// Set while the manager runs with debugFeed on: mirror one turn to the owner.
	let deliverManagerFeed:
		| ((
				log: ManagerTurnLog,
				thinking: string,
				tools: readonly ManagerToolCall[],
		  ) => Promise<void>)
		| null = null;
	// One-shot guard so a broken debug feed is surfaced once, not every turn.
	let managerFeedWarned = false;
	// Set while the manager runs with debugFeed on: relay a runtime warning/error/
	// info notice to the owner's bot DM.
	let mirrorManagerNotice:
		| ((level: ManagerNoticeLevel, message: string) => void)
		| null = null;
	let managerClient: TelegramClient | null = null;
	let managerTick: ReturnType<typeof setInterval> | null = null;
	let managerHeartbeat: ReturnType<typeof setInterval> | null = null;
	let managerUi: {
		setWidget: ExtensionCommandContext["ui"]["setWidget"];
	} | null = null;

	// `/switch` control state. `activeCtx` is the most recent command context —
	// needed so a Telegram button press (which has no Pi ctx) can still notify and
	// restart a mode; captured on every mode start. `ownerUserId` gates control to
	// the owner.
	let activeCtx: ExtensionCommandContext | null = null;
	let ownerUserId: number | null = null;
	// The configured zone, for the clock the mode pin carries. Set on every mode start.
	let activeTimezone: string | undefined;
	// The settings the RUNNING mode started with — what `about current_settings`
	// reports. Not what is in the file: a file edited since then is not what the bot
	// is doing, and saying otherwise is exactly the confusion `about` exists to end.
	let activeSettings: TelegramSettings | null = null;
	// Pages read by `about` in the running turn (see its `claimCall`). Reset per turn.
	let aboutCallsThisTurn = 0;

	// Mixed mode: the manager runtime coexists with the owner's coding thread in
	// ONE session. `polarity` says whose turn the shared brain is serving right
	// now: `coding` (owner is at the keyboard — Telegram is deferred, tools are
	// unrestricted) or `telegram` (owner is idle — the manager moderates in its
	// sandbox). `mixedActive` is set only while `/telegram-mixed` runs. The return
	// timer flips polarity back to `telegram` after the owner's inference has been
	// idle for `mixedReturnMs`.
	let mixedActive = false;
	let polarity: "coding" | "telegram" = "coding";
	let mixedReturnMs = 480_000;
	let mixedReturnTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Every mode message this bot has posted and not yet removed, newest last.
	 *
	 * Not one id but a LIST, because the chat is the only real record and we are not
	 * its only author: a mode message can survive us (a crash between posting and
	 * saving, a `/start` that deliberately let go of the old one), and one forgotten
	 * message means the chat keeps a stale "Bot mode: …" line forever while the next
	 * switch deletes the wrong one. Deleting the whole list on every update makes the
	 * chat converge on exactly one mode message, whatever happened before.
	 *
	 * Persisted, because the ids live in the owner's DM and not in this process: a
	 * restarted Pi that forgot them used to pin a SECOND message next to the first.
	 */
	let modePinMessageIds: number[] = [];
	interface ModePinState {
		ownerChatId: number;
		/** Historic single-id form; still read so an existing pin is not orphaned. */
		messageId?: number;
		messageIds?: number[];
	}
	let modePinLoaded = false;

	const loadModePin = async (ownerChatId: number): Promise<void> => {
		if (modePinLoaded) return;
		modePinLoaded = true;
		const stored = await readJsonIfExists<ModePinState>(
			fs,
			paths.modePinPath,
		).catch(() => null);
		if (!stored || stored.ownerChatId !== ownerChatId) return;
		modePinMessageIds = [
			...(stored.messageIds ?? []),
			...(stored.messageId !== undefined ? [stored.messageId] : []),
		];
	};

	/** Forget the pin entirely (an error path: better a new one than a ghost). */
	const forgetModePin = async (): Promise<void> => {
		modePinMessageIds = [];
		await fs.removeFile(paths.modePinPath).catch(() => {});
	};

	const saveModePin = async (
		ownerChatId: number,
		messageIds: number[],
	): Promise<void> => {
		modePinMessageIds = messageIds;
		await writeJson<ModePinState>(fs, paths.modePinPath, {
			ownerChatId,
			messageIds,
		}).catch(() => {});
	};

	// Connection watchdog: a silent timer that probes the active bot connection and
	// auto-disconnects after too many consecutive failures. `connectionFailures` is
	// the running streak (reset only by a healthy probe, so it survives across
	// probes); `watchdogBusy` guards against overlapping slow probes.
	let watchdogTimer: ReturnType<typeof setInterval> | null = null;
	let watchdogBusy = false;
	let connectionFailures = 0;

	const updateManagerBanner = (): void => {
		// Mixed mode deliberately shows no manager banner/widgets — only the footer
		// status line (see updateMixedFooter). The owner is coding; the chat-status
		// board would be noise.
		if (!manager || !managerUi || mixedActive) return;
		try {
			// Clip to the terminal: an over-long widget line desyncs Pi's fixed-width
			// layout, so a narrow window would break the frame.
			managerUi.setWidget(
				MANAGER_BANNER_KEY,
				fitLines(managerBannerLines(manager.status()), terminalWidth()),
			);
		} catch {
			// A captured UI handle may go stale across a session reload; the banner
			// is cosmetic, so a failed refresh must never break the manager.
		}
	};

	// Mixed mode's only persistent TUI chrome: a one-line status showing the mode,
	// which polarity the shared brain is serving right now.
	const updateMixedFooter = (): void => {
		if (!mixedActive) return;
		const where = polarity === "telegram" ? "in Telegram" : "coding";
		activeCtx?.ui.setStatus(
			STATUS_KEY,
			fitLine(`mixed · ${where}`, terminalWidth()),
		);
	};

	const cancelMixedReturnTimer = (): void => {
		if (mixedReturnTimer) {
			clearTimeout(mixedReturnTimer);
			mixedReturnTimer = null;
		}
	};

	// Arm the idle timer that flips the shared brain back to Telegram moderation
	// once the owner's coding turn has been idle for `mixedReturnMs`.
	const armMixedReturnTimer = (): void => {
		if (!mixedActive) return;
		cancelMixedReturnTimer();
		mixedReturnTimer = setTimeout(() => {
			mixedReturnTimer = null;
			if (!mixedActive || polarity === "telegram") return;
			setPolarity("telegram");
			// Kick the manager immediately rather than waiting for the next tick.
			// A tick must never take the process with it: an escaping rejection here is an
			// unhandled rejection, and Node ends the process for one.
			void manager
				?.onTick()
				.then(updateManagerBanner)
				.catch(() => {});
		}, mixedReturnMs);
	};

	// Flip the mixed-mode polarity and re-gate everything that depends on it: the
	// manager's tool sandbox (active only in the Telegram polarity, so coding keeps
	// full tools) and the footer indicator.
	const setPolarity = (next: "coding" | "telegram"): void => {
		polarity = next;
		if (mixedActive)
			visibility.setActive("manager", managerHoldsSession(mixedActive, next));
		updateMixedFooter();
	};

	/**
	 * Wait for the session to go idle — but never forever.
	 *
	 * `waitForIdle()` resolves from ONE place in Pi: the `finally` of the run that is
	 * currently active. A run that ends without settling (an abort the agent does not
	 * come back from) leaves that promise unresolved for the rest of the process, and
	 * whoever awaited it is simply gone. That is how a wedged session turned into a
	 * silent bot: the queue pump was parked on this await, and the owner's messages sat
	 * in our queue with nothing left alive to send them.
	 *
	 * Returns whether it actually went idle.
	 */
	const waitForIdle = async (
		ctx: ExtensionCommandContext,
		timeoutMs: number,
	): Promise<boolean> => {
		if (ctx.isIdle()) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		try {
			return await Promise.race([ctx.waitForIdle().then(() => true), timedOut]);
		} catch {
			return ctx.isIdle();
		} finally {
			if (timer) clearTimeout(timer);
		}
	};

	/**
	 * Hand a prompt to the agent — and only ever while the session is REALLY idle, and
	 * only ever ONE hand-off at a time.
	 *
	 * `sendUserMessage` starts a turn when the agent is idle and QUEUES otherwise. A
	 * queued message is not safe: on any abort the TUI calls
	 * `restoreQueuedMessagesToEditor`, which empties the queue into the editor, where
	 * it sits waiting for a human to press Enter. The manager aborts at the end of
	 * every turn (to stop the model re-sampling its decision), so anything queued was
	 * reliably diverted into the editor instead of being answered — which is exactly
	 * the "it ends up in the editor" we kept seeing.
	 *
	 * Our own `busy` flag is not enough: it clears on `agent_end`, while the SESSION is
	 * still finishing, so a message sent from that handler (the queue pump does exactly
	 * that) still lands in the queue. `waitForIdle()` is the session's own answer, so
	 * we ask it, not ourselves — but with a deadline, and we THROW when it passes.
	 *
	 * And then we CONFIRM. `pi.sendUserMessage` is fire-and-forget (it returns `void`;
	 * the SDK swallows the promise), so awaiting it proves nothing, and it fails for
	 * real: right after an abort the session says idle while the run is still unwinding,
	 * `agent.prompt()` throws "Agent is already processing a prompt", and the message is
	 * gone — silently, because the call could not tell us. A prompt that was accepted
	 * starts a turn, so we wait for `agent_start` (see {@link TurnSignal}) and treat its
	 * absence as a failed hand-off: the message stays in our queue, and the pump tries
	 * again.
	 */
	const deliverPrompt = async (content: PromptContent): Promise<void> => {
		// One at a time: a second attempt while the first is still unconfirmed cannot be
		// told apart from a retry, and a retry that lands twice sends the message twice.
		if (deliveryInFlight) {
			throw new Error("a hand-off is already in flight; message kept in queue");
		}
		deliveryInFlight = true;
		try {
			if (activeCtx && !(await waitForIdle(activeCtx, IDLE_WAIT_MS))) {
				noteSessionStuck();
				throw new Error(
					"the Pi session did not go idle; message kept in queue",
				);
			}
			// Armed BEFORE the send, so a turn that starts immediately is not missed.
			let started = turnStarted.next(TURN_START_WAIT_MS);
			pi.sendUserMessage(content, { deliverAs: "followUp" });
			const deadline = Date.now() + TURN_START_MAX_WAIT_MS;
			while (!(await started)) {
				// Pi runs a compaction INSIDE `prompt()`, before the turn — and a local model
				// summarising a full context takes minutes. A prompt waiting behind one has
				// not failed, and re-sending it would both duplicate the message and pile a
				// second compaction on the first.
				if (!compactionInFlight() || Date.now() >= deadline) {
					noteSessionStuck();
					throw new Error(
						"the prompt never started a turn; message kept in queue",
					);
				}
				started = turnStarted.next(TURN_START_WAIT_MS);
			}
			sessionStuckSince = 0;
		} finally {
			deliveryInFlight = false;
		}
	};

	const sendFollowUp = async (content: PromptContent): Promise<void> => {
		await deliverPrompt(content);
	};

	/**
	 * A session that will not go idle is not a slow session — nothing is running, and
	 * nothing ever will. Say so once, and say what actually recovers it, instead of
	 * leaving the chat to wonder why the bot went quiet.
	 */
	let sessionStuckSince = 0;
	let sessionStuckWarned = false;
	const noteSessionStuck = (): void => {
		const now = Date.now();
		if (sessionStuckSince === 0) {
			sessionStuckSince = now;
			return;
		}
		if (sessionStuckWarned || now - sessionStuckSince < STUCK_WARN_AFTER_MS)
			return;
		sessionStuckWarned = true;
		void connect
			?.sendToChat(
				card("⚠️", "The Pi session is not responding", [
					"It has been busy with nothing running for several minutes, so I cannot hand it your messages.",
					bullet(
						"Kept",
						"your messages are still queued here — nothing is lost",
					),
					note("Try /esc. If that does not free it, restart Pi."),
				]),
			)
			.catch(() => {});
	};

	/**
	 * The real Escape — the one the keyboard does.
	 *
	 * `ctx.abort()` IS the Escape key's own handler (it empties the queues and aborts
	 * the agent). Our AbortRegistry only knows the turn we armed on `agent_start` and
	 * disarmed on `agent_end` — so the moment our bookkeeping disagreed with the
	 * session (a run that ended for us but never settled for Pi), /esc answered
	 * "nothing to cancel" and did nothing at all, which is the one moment it was needed.
	 *
	 * So we ask the SESSION, not ourselves, and we report what actually happened —
	 * including "it did not stop", which is a real outcome and used to be silence.
	 */
	/**
	 * The `/status` card: what the session is doing RIGHT NOW.
	 *
	 * Every value is read from Pi at the moment it is asked for — the model, the context
	 * usage, the working directory, the thinking level — because a status assembled from
	 * what we remembered at mode start is a status about the past. Anything Pi does not
	 * report is simply left out of the card; see `renderStatusCard`.
	 */
	const statusInput = (): StatusInput => {
		const ctx = activeCtx;
		const mode: StatusMode["mode"] = manager
			? mixedActive
				? "mixed"
				: "manager"
			: "personal";
		const usage = ctx?.getContextUsage();
		return {
			runtime: { mode, polarity: mixedActive ? polarity : undefined },
			model: ctx?.model
				? {
						name: ctx.model.name,
						id: ctx.model.id,
						provider: ctx.model.provider,
					}
				: undefined,
			context: usage
				? {
						tokens: usage.tokens,
						contextWindow: usage.contextWindow,
						percent: usage.percent,
					}
				: undefined,
			cwd: ctx?.cwd,
			// These live on `pi`, not on the command context.
			sessionName: pi.getSessionName(),
			thinkingLevel: pi.getThinkingLevel(),
			busy,
			queued: connect?.pendingCount(),
			manager: manager?.status(),
			uptimeMs: modeStartedAt > 0 ? Date.now() - modeStartedAt : undefined,
		};
	};

	const buildStatus = (): string => renderStatusCard(statusInput());

	/**
	 * What `/context` reports: the context we last built (ours, measured), the size of
	 * the last call (Pi's, exact), and the last compaction (the usual answer to "why
	 * did it forget the beginning").
	 */
	const contextInput = (): ContextReportInput => {
		const usage = activeCtx?.getContextUsage();
		return {
			snapshot: lastContext ?? undefined,
			usage: usage
				? {
						tokens: usage.tokens,
						contextWindow: usage.contextWindow,
						percent: usage.percent,
					}
				: undefined,
			compaction: lastCompaction ?? undefined,
			now: Date.now(),
		};
	};
	const buildContextReport = (): string => renderContextCard(contextInput());

	/** What the chat is told about an /esc — including the outcome that used to be silence. */
	const escapeCard = (outcome: "aborted" | "idle" | "stuck"): string => {
		if (outcome === "aborted") {
			return card("⎋", "Cancelled", [note("Stopped the current turn.")]);
		}
		if (outcome === "idle") {
			return card("💤", "Nothing to cancel", [note("The agent is idle.")]);
		}
		return card("⚠️", "It did not stop", [
			"The session is still busy after the abort — which means nothing is actually running in it.",
			note("Restart Pi to recover. Your messages stay queued here."),
		]);
	};

	const escapeSession = async (): Promise<"aborted" | "idle" | "stuck"> => {
		const ctx = activeCtx;
		if (!ctx) return (await abort.abort()) ? "aborted" : "idle";
		const wasBusy = !ctx.isIdle();
		ctx.abort();
		if (!wasBusy) return "idle";
		// An abort is not instant: the run unwinds, the tool call rejects, the session
		// settles. Give it that, then tell the truth about where we ended up.
		const settled = await waitForIdle(ctx, ESC_SETTLE_MS);
		return settled ? "aborted" : "stuck";
	};

	// The Telegram "typing…" indicator lasts ~5s, so we refresh it on a timer
	// while the agent is working on a turn.
	const stopTyping = (): void => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = null;
		}
	};
	const startTyping = (): void => {
		if (!connect) return;
		void connect.sendTyping();
		stopTyping();
		typingTimer = setInterval(() => {
			void connect?.sendTyping();
		}, TYPING_REFRESH_MS);
	};

	/**
	 * Whether the animated trace may be shown at all.
	 *
	 * `thinkingPlaceholder` is its own switch, and it is OFF by default — the placeholder
	 * is beta: it rides `<tg-thinking>`, the newest thing we send, and a client that
	 * renders it badly is not something we can fix from here. Off, nothing about it runs:
	 * no draft, no refresh timer, no trace kept.
	 *
	 * It still rides the streaming draft, which exists only in the owner's own chat:
	 * personal mode always, mixed mode only on a coding turn. `ownerRun` is exactly that
	 * distinction — a MANAGER turn never gets one, and could not anyway (a draft cannot be
	 * sent over a business connection).
	 */
	const thinkingAllowed = (): boolean =>
		connect !== null && thinkingEnabled && draftPreviewsEnabled && ownerRun;

	const stopThinking = (): void => {
		thinkingUp = false;
		thinkingLog.clear();
		lastThinkingHtml = "";
		lastThinkingAt = 0;
		if (thinkingTimer) {
			clearInterval(thinkingTimer);
			thinkingTimer = null;
		}
	};

	/**
	 * Push the trace into the draft, and keep it alive. Two clocks are at work: a
	 * draft expires ~30s after its last update, and the running step shows its own
	 * elapsed seconds — both want a refresh well under half a minute. Re-sending the
	 * SAME draft id animates in place, so refreshing is invisible: no flicker, and the
	 * timer simply ticks.
	 *
	 * Identical content is NOT re-sent, except to beat the expiry: while the model is
	 * merely sampling, the trace says the same thing every tick, and repeating it at
	 * the tick rate is traffic that buys nothing. (Telegram's own limit is one message
	 * per second per chat — this stays far under it either way.)
	 */
	const pushThinking = (): void => {
		const now = Date.now();
		const html = thinkingLog.html(now);
		const unchanged = html.html === lastThinkingHtml;
		if (unchanged && now - lastThinkingAt < THINKING_KEEPALIVE_MS) return;
		lastThinkingHtml = html.html;
		lastThinkingAt = now;
		void connect?.streamThinking(html);
	};

	const showThinking = (): void => {
		if (!thinkingAllowed()) return;
		thinkingUp = true;
		pushThinking();
		if (thinkingTimer) return;
		thinkingTimer = setInterval(() => {
			if (!thinkingUp) return;
			pushThinking();
		}, THINKING_REFRESH_MS);
	};

	/**
	 * Take the placeholder DOWN before a real message goes up.
	 *
	 * A draft holds the position it was created at, and every real message we send after
	 * it — a tool card, a log file — lands BELOW it. So the placeholder was left sitting
	 * above newer messages, still animating, reading exactly like a turn that hung: the
	 * one thing it exists to disprove.
	 *
	 * The rule is that the placeholder is always the LAST thing in the chat. It is erased
	 * before anything real is sent, and {@link raisePlaceholder} puts it back underneath
	 * once that message has landed — a fresh draft, at the bottom, where "what is
	 * happening right now" belongs.
	 */
	const dropPlaceholder = async (
		controller: ConnectController,
	): Promise<void> => {
		thinkingUp = false;
		if (thinkingTimer) {
			clearInterval(thinkingTimer);
			thinkingTimer = null;
		}
		lastThinkingHtml = "";
		lastThinkingAt = 0;
		// Erase whatever draft is up — the trace, or the streamed preview of the reply —
		// and close its id, so the next draft opens fresh. A new id is what makes it
		// appear at the BOTTOM of the chat rather than back where the old one stood.
		// The turn's steps are NOT forgotten (that is `stopThinking`): the trace comes
		// back saying the same thing, one message further down.
		await controller.clearDraft().catch(() => {});
	};

	/** Put the trace back below the message that just landed, if the turn is still running. */
	const raisePlaceholder = (): void => {
		if (busy) showThinking();
	};

	/**
	 * Hold the answer's place while the step before it finishes going out. The reply is
	 * written and the model is done; what is left is the previous card's full-output
	 * file, which is uploading and must land above the answer. The draft says so — it is
	 * the one surface that can speak while a real message is queued behind an upload.
	 */
	const showSendingOutput = (): void => {
		thinkingLog.clear();
		thinkingLog.setHeadline(SENDING_OUTPUT_HEADLINE);
		showThinking();
	};

	// The bot's own documentation, readable in every mode. The model picks a topic
	// from a fixed list — it can never name a file or a path, so nothing anyone writes
	// to it can steer this at another document.
	for (const tool of createAboutTools({
		fs,
		docsDir: ABOUT_DOCS_DIR,
		// Budgeted per turn: `about` decides nothing, and a manager turn only ends when
		// the model calls reply/silent — so an unbudgeted `about` is a way for the model
		// to spin forever without ever answering anyone.
		claimCall: () => ++aboutCallsThisTurn <= ABOUT_CALLS_PER_TURN,
		// A manager turn is answering a stranger. Personal — and mixed while the owner
		// is coding — is the owner's own chat.
		isOwnerTurn: () => !managerHoldsSession(mixedActive, polarity) || !manager,
		settingsReport: () => {
			if (!activeSettings) return null;
			const mode = manager
				? mixedActive
					? ("mixed" as const)
					: ("manager" as const)
				: ("personal" as const);
			return renderSettingsReport({ settings: activeSettings, mode });
		},
	})) {
		pi.registerTool(tool);
	}

	// Registered once at load; the visibility gate hides it until a mode is
	// active, and it routes through whichever ConnectController is live. Mode 1
	// mirrors the model's reply text automatically, so only file-sending needs a
	// tool — there is intentionally no "send a text message" tool.
	for (const tool of createAttachmentTools({
		async sendAttachment(input) {
			// Route to the live connect controller, which uploads the file to the
			// bound chat (local path or URL). Throwing here surfaces the exact error
			// to the model via the tool's error result.
			if (!connect) throw new Error("Telegram connect is not active.");
			await connect.sendFile(input);
		},
	})) {
		pi.registerTool(tool);
	}

	// Manager decision tools, gated by the "manager" visibility group. They route
	// to whichever ManagerController is live via a stable proxy sink.
	const managerDecisionSink: DecisionSink = {
		record: (decision) => manager?.decisionSink().record(decision),
	};
	const managerFactSink: FactSink = {
		record: (facts) => manager?.factSink().record(facts),
	};
	const managerProbeSink: ProbeSink = {
		record: (result) => manager?.probeSink().record(result),
	};
	const managerResolveSink: DraftResolutionSink = {
		record: (resolution) => manager?.resolveSink().record(resolution),
	};
	for (const tool of [
		...createManagerTools(managerDecisionSink, managerFactSink),
		...createInterrogationTools(managerProbeSink),
		createDraftResolveTool(managerResolveSink),
	]) {
		pi.registerTool(tool);
	}

	const stopConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		stopTyping();
		stopThinking();
		disarmWatchdog();
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (queuePump) {
			clearInterval(queuePump);
			queuePump = null;
		}
		await client?.stop().catch(() => {});
		client = null;
		connect = null;
		connectSystemBlock = null;
		// Nothing will ever confirm a hand-off that is still waiting: the mode is gone.
		turnStarted.clear();
		compactingSince = 0;
		// The next mode builds its own context; reporting the last one built by the mode
		// that just ended would be a true number about a thread that is gone.
		lastContext = null;
		toolActivityEnabled = false;
		draftPreviewsEnabled = false;
		thinkingEnabled = false;
		toolOutputMaxBytes = 0;
		activeSettings = null;
		contextReset.forget();
		await lifecycle.deactivate("connect");
		visibility.setActive("connect", false);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const stopManager = async (): Promise<void> => {
		disarmWatchdog();
		if (notConnectedTimer) {
			clearTimeout(notConnectedTimer);
			notConnectedTimer = null;
		}
		secretaryTrafficSeen = false;
		if (managerTick) {
			clearInterval(managerTick);
			managerTick = null;
		}
		if (managerHeartbeat) {
			clearInterval(managerHeartbeat);
			managerHeartbeat = null;
		}
		await managerClient?.stop().catch(() => {});
		managerClient = null;
		manager = null;
		deliverManagerFeed = null;
		mirrorManagerNotice = null;
		visibility.setActive("manager", false);
		visibility.setExclusive("manager", null);
		managerMatcher = null;
		managerUi?.setWidget(MANAGER_BANNER_KEY, undefined);
		managerUi = null;
		// See `stopConnect`: the context that was measured belonged to the mode that is
		// ending, and /context must not report it as if it were still the one in use.
		turnStarted.clear();
		compactingSince = 0;
		lastContext = null;
		// Tear down mixed-mode state (a no-op for the standalone manager). Deactivate
		// the lifecycle record for whichever mode was actually running.
		const wasMixed = mixedActive;
		if (wasMixed) {
			cancelMixedReturnTimer();
			mixedActive = false;
			polarity = "coding";
			// Mixed owns the personal bridge too (it runs on the manager's client, which
			// is already stopped above) — tear it down here, without touching the
			// `connect` lifecycle record, which mixed never activated.
			stopTyping();
			stopThinking();
			connect = null;
			connectSystemBlock = null;
			toolActivityEnabled = false;
			draftPreviewsEnabled = false;
			thinkingEnabled = false;
			toolOutputMaxBytes = 0;
			contextReset.forget();
			visibility.setActive("connect", false);
			activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		}
		await lifecycle.deactivate(wasMixed ? "mixed" : "manager");
	};

	// Route business updates to the manager controller. Owner control commands
	// (`/switch`, panel button presses) are intercepted first, in both modes.
	const routeManagerEvent = async (event: TelegramEvent): Promise<void> => {
		if (await handleStartCommand(event)) return;
		if (await handleControl(event)) return;
		// Mixed: the owner writing in their own bot DM is the personal bridge, not a
		// managed conversation. It carries the same priority as the terminal — take
		// the brain back for coding (aborting a moderation turn in flight) and hand
		// the message to the ConnectController. Which topic it was typed in changes
		// only where the message ends up, never whether it is answered.
		if (
			connect &&
			(event.kind === "message" || event.kind === "edited_message") &&
			event.fromId === ownerUserId &&
			event.chatId === ownerUserId
		) {
			await acceptAsPersonal(event);
			// A question ABOUT the bot is not the owner taking over. `/status`, `/context`
			// and `/help` are answered from our own state — the model never sees them — so
			// taking the session for one would abort a manager turn in flight: a stranger's
			// half-written reply dying because the owner asked how full the context was.
			// Everything else, `/esc` and `/clear` and `/compact` included, IS the owner
			// reaching into the session, and takes it.
			if (!isReadOnlyBridgeCommand(event.message.text)) {
				await takeSessionForCoding();
			}
			await connect.onEvent(event);
			return;
		}
		if (!manager) return;
		// Proof that the Secretary side works — cancels the "not connected" claim.
		if (
			event.kind === "business_connection" ||
			event.kind === "business_message" ||
			event.kind === "edited_business_message"
		) {
			cancelNotConnectedCheck();
		}
		// Learn the connection from the traffic itself. `business_connection` is only
		// delivered when the connection CHANGES, so a bot connected before its first run
		// never had one persisted — and everything keyed on the stored connection was
		// silently degraded: the manager could not tell the OWNER's own messages from an
		// interlocutor's (that identity is `connection.userId`), and the startup check
		// claimed "not connected" on every start. Each business message carries its
		// connection id, and `getBusinessConnection` turns that id into the real thing.
		if (
			event.kind === "business_message" ||
			event.kind === "edited_business_message" ||
			event.kind === "deleted_business_messages"
		) {
			await learnBusinessConnection(event.connectionId);
		}
		if (event.kind === "business_connection") {
			// Read the stored record BEFORE the update overwrites it: what the owner
			// needs to hear is the TRANSITION (the right was just taken away), not the
			// state (it is absent), which the startup check already reports.
			const previous = await businessStore.get(event.connectionId);
			await manager.onBusinessConnection({
				connectionId: event.connectionId,
				connection: event.connection,
				isEnabled: event.isEnabled,
			});
			const alerts = connectionAlerts(
				previous
					? { canReply: previous.canReply, isEnabled: previous.isEnabled }
					: null,
				{
					canReply: event.connection.rights?.can_reply,
					isEnabled: event.isEnabled,
				},
			);
			for (const alert of alerts) {
				const good = alert === "enabled" || alert === "reply_right_restored";
				await notifyOwner(
					CONNECTION_ALERT_NOTICES[alert],
					good ? "info" : "warning",
				);
			}
		} else if (event.kind === "business_message") {
			await manager.onBusinessMessage({
				connectionId: event.connectionId,
				chatId: String(event.chatId),
				fromId: event.fromId,
				message: event.message,
			});
			updateManagerBanner();
		}
	};

	pi.on("agent_start", async (_event, ctx) => {
		busy = true;
		// The turn started — which is the only proof we can get that the prompt behind it
		// was ever accepted. See `deliverPrompt`.
		turnStarted.fire();
		// A turn is running, so whatever compaction preceded it is over, whether or not it
		// said so.
		compactingSince = 0;
		managerTurnTools = [];
		aboutCallsThisTurn = 0;
		// Whose run is this? Personal mode: always the owner's. Mixed: only a coding
		// turn is. Captured at the START of the run, because a mid-run owner action
		// flips the polarity — the run itself stays what it was, and a manager run
		// must never be mirrored into the owner's chat topic (typing, drafts, the
		// final reply, tool activity all key off this).
		ownerRun = manager === null || !managerHoldsSession(mixedActive, polarity);
		mirroredThisRun = false;
		// Arm the interrupt for the running turn in BOTH modes, so a priority owner
		// action can abort it immediately: /esc in mode 1, or /switch in either mode
		// (which must not wait for a long consolidation/reply to finish).
		abort.set(() => ctx.abort());
		if (ownerRun) {
			startTyping();
			// Fill the silence between the prompt and the first token: until a tool is
			// called, the only true thing to say is that the model is sampling.
			thinkingLog.clear();
			showThinking();
		}
	});
	// End the manager's agent run as soon as it has made the turn's terminal
	// decision. A single manager tool does not end the agentic loop (a tool call
	// re-samples the model), and pi.on("context") rebuilds byte-identical context
	// each sample, so without this the model repeats the same decision dozens of
	// times until it happens to emit plain text. Aborting here caps it at one
	// inference; the reply is still delivered from onAgentEnd (reading the recorded
	// decision, not the messages the abort may orphan).
	pi.on("turn_end", (_event, ctx) => {
		// Only cap a manager turn. In mixed mode's coding polarity the owner is
		// running the turn — never abort it on the manager's stale decision flag.
		if (!managerHoldsSession(mixedActive, polarity) || !manager) return;
		// Never abort ON TOP of a queued message. An abort makes the TUI empty the
		// queue into the terminal editor (`restoreQueuedMessagesToEditor`), where the
		// message stops being a Telegram turn and becomes text waiting for a human to
		// press Enter. `deliverPrompt` keeps the queue empty, so this should not
		// happen — but the cost of being wrong is a conversation silently stranded in
		// an editor, and the cost of skipping the abort is one extra sample.
		if (ctx.hasPendingMessages()) return;
		// Consolidation now walks its whole interrogation in ONE agent run: step the
		// state machine here (no per-probe abort) and abort only when it asks — live
		// conversation work is waiting, or the interrogation is already done and the
		// model kept calling tools (backstop). Otherwise let the loop re-sample; the
		// context rebuild shows the next probe (or MANAGER_TURN_DONE when finished).
		if (manager.isConsolidating()) {
			if (manager.stepConsolidation() === "abort") ctx.abort();
			return;
		}
		// A normal reply/silent turn: cap re-sampling once the decision is recorded.
		if (manager.turnDecided()) ctx.abort();
	});
	pi.on("agent_end", async (event) => {
		busy = false;
		// Disarm the interrupt for the finished turn (both modes); the next turn
		// re-arms it in agent_start.
		abort.clear();
		stopTyping();
		// A placeholder still up when the run ends means no reply text ever streamed —
		// an abort (/esc), an error, or a run that only called tools. Nothing will
		// overwrite it, so erase it; otherwise it keeps animating until it expires.
		const placeholderWasUp = thinkingUp;
		stopThinking();
		if (placeholderWasUp) {
			await connect?.clearDraft();
		} else {
			connect?.endDraft();
		}
		const controller = connect;
		if (controller) {
			// A card still open here belongs to a call that never returned — the turn was
			// aborted under it. Nothing will ever complete it, so close it as cancelled
			// instead of leaving it wearing the running state. It edits the chat, so it
			// waits its turn like every other write.
			await chatLane
				.run(() => controller.cancelOpenToolCards())
				.catch(() => {});
			// Then let the whole turn land before the run has its last word. Draining here
			// rather than queueing behind it keeps the lane free: `onAgentEnd` also pumps
			// the message queue, which waits for the SESSION to go idle — a wait that has
			// no business holding up the chat.
			await chatLane.drain();
			// A manager run in mixed still pumps the connect queue (an owner message may be
			// waiting behind the aborted moderation turn) but its text is NOT a reply to the
			// owner — only an owner run delivers to the chat topic. The run's messages were
			// mirrored one by one as they ended; this fallback only fires when none of them
			// was (an aborted or otherwise odd run), so an answer can never be lost.
			await controller
				.onAgentEnd(event.messages, ownerRun && !mirroredThisRun)
				.catch(() => {});
		}
		// In mixed mode's coding polarity the turn that just ended is the owner's:
		// don't feed it to the manager, and arm the idle timer that will hand the
		// shared brain back to Telegram once the owner stays quiet.
		if (!managerHoldsSession(mixedActive, polarity)) {
			armMixedReturnTimer();
			return;
		}
		if (manager) {
			// Pass the trailing assistant prose so the manager can recover a reply the
			// model wrote as plain text instead of calling a tool (otherwise dropped).
			const log = await manager.onAgentEnd(
				lastAssistantReply(event.messages) ?? undefined,
			);
			updateManagerBanner();
			// Mirror the turn (thinking, tools, decision) to the owner's bot DM when
			// the debug feed is on. Best-effort — a feed failure never blocks a reply,
			// but the first failure is logged so a misconfigured feed is diagnosable.
			// Skip an empty card (a silent turn with no reason) — just noise. A silent
			// WITH a reason, a reply, a hold, or a correction still posts.
			if (log && deliverManagerFeed && !isEmptyFeedTurn(log)) {
				// Errors are surfaced inside the sender (once), so swallow here.
				await deliverManagerFeed(
					log,
					lastAssistantThinking(event.messages),
					managerTurnTools,
				).catch(() => {});
			}
		}
	});
	pi.on("tool_execution_start", async (event) => {
		// Record every manager tool call for the debug feed, before the connect guard
		// (mode 2 has no ConnectController but still needs the feed). In mixed mode's
		// coding polarity these are the owner's own tool calls — not manager turns.
		if (manager && managerHoldsSession(mixedActive, polarity)) {
			let args = "";
			try {
				args = JSON.stringify(event.args) ?? "";
			} catch {
				args = "";
			}
			managerTurnTools.push({ name: event.toolName, args });
		}
		// The live trace rides the draft, not the cards, so it updates even when the tool
		// CARDS are switched off. With the placeholder itself off, none of it runs — not
		// even the bookkeeping: `thinkingEnabled` gates the whole feature, not just its
		// sends.
		if (thinkingEnabled) {
			thinkingLog.start({
				callId: event.toolCallId,
				toolName: event.toolName,
				hint: toolActivityHint({ toolName: event.toolName, args: event.args }),
				startedAt: Date.now(),
			});
			showThinking();
		}
		if (!connect || !toolActivityEnabled || !ownerRun) return;
		const controller = connect;
		// Queued here, synchronously, so the card takes the place in the chat that its
		// event had — see `chatLane`.
		await chatLane
			.run(async () => {
				// The card is a real message, so the placeholder comes down first and goes
				// back up underneath it — never above it, looking stranded.
				await dropPlaceholder(controller);
				await controller.sendToolActivity(
					{ toolName: event.toolName, args: event.args },
					event.toolCallId,
				);
				raisePlaceholder();
			})
			.catch(() => {});
	});

	// The call returned: finish its card in place with ✅/❌ and the folded output, so
	// a run of wrenches shows at a glance which step failed — instead of every card
	// looking identical and having to be expanded to find out.
	pi.on("tool_execution_end", async (event) => {
		// Close the step in the live trace first: it ticks (or crosses) even when the
		// cards are off, and it must stop counting seconds the moment the tool returns.
		if (thinkingUp) {
			thinkingLog.finish(event.toolCallId, Date.now(), event.isError);
			showThinking();
		}
		if (!connect || !toolActivityEnabled || !ownerRun) return;
		const controller = connect;
		// The card and the file it carries are ONE step of the chat: queued together, so
		// nothing (least of all the final answer) can slip between a card and its log.
		await chatLane
			.run(async () => {
				// Completing the card is an EDIT — it adds nothing to the chat, so the
				// placeholder can stay where it is. A file, if one follows, is a real
				// message; `attachToolOutputFile` takes the placeholder down for it, and
				// only if it really sends something.
				const cardId = await controller
					.completeToolActivity(event.toolCallId, event.result, event.isError)
					.catch(() => undefined);
				await attachToolOutputFile(event.result, event.toolName, cardId);
				raisePlaceholder();
			})
			.catch(() => {});
	});

	/**
	 * Send the tool's own full-output file when its output was truncated — the log
	 * behind the card's "… (75 earlier lines)", which otherwise exists only on the
	 * machine running Pi. WE decide this, not the model: it is a mechanical rule (was
	 * it truncated, is it small enough), and making the agent spend a turn on it would
	 * only invite it to get it wrong.
	 */
	const attachToolOutputFile = async (
		result: unknown,
		toolName: string,
		cardMessageId?: number,
	): Promise<void> => {
		if (!connect || toolOutputMaxBytes <= 0) return;
		const details = (result as { details?: unknown } | undefined)?.details;
		const path = fullOutputPath(details);
		const plan = planAttachment({
			details,
			text: unwrapToolResult(result),
			shownChars: DEFAULT_MAX_RESULT_CHARS,
			maxBytes: toolOutputMaxBytes,
			toolFileBytes: path ? await fs.size(path) : undefined,
		});
		if (plan.attach === false) return;
		// A file IS a real message, so the placeholder comes down for it — but only now,
		// once we know one is actually going out. Most calls attach nothing, and taking
		// the trace down and putting it back for them would be a flicker that says
		// nothing.
		await dropPlaceholder(connect);
		const caption = `📄 full output — ${toolName}`;
		// One name for both routes. A tool writes its log where and how it likes
		// (`/tmp/pi-bash-1.log`), but what arrives on the owner's PHONE is judged by its
		// extension: a `.txt` opens and previews, a `.log` is an unknown blob you must go
		// find an app for. So the file is delivered as the plain text it is.
		const filename = toolOutputFileName(toolName, Date.now());
		if (plan.attach === "file") {
			await connect.attachToolOutput(
				plan.path,
				caption,
				cardMessageId,
				filename,
			);
			return;
		}
		// Nobody saved this but us: the tool returned everything and the CARD is what
		// cut it. Write it out inside the extension dir (never the system temp dir, so
		// the path is ours on every platform), send it, and delete it — this file has
		// no life beyond the message it rode in on.
		const scratch = join(toolOutputDir, filename);
		try {
			await fs.writeText(scratch, plan.text);
			await connect.attachToolOutput(scratch, caption, cardMessageId, filename);
		} catch {
			// A scratch file we could not write or send is not worth a word to the user:
			// the card still carries the truncated output.
		} finally {
			await fs.removeFile(scratch).catch(() => {});
		}
	};

	// Live streaming preview: open a draft when the assistant message starts and
	// animate it (throttled) as tokens arrive. The draft is ephemeral — it never
	// edits or deletes a real message; the final reply is a fresh send in
	// onAgentEnd, so the full history is preserved.
	pi.on("message_start", (event) => {
		if (!connect || !draftPreviewsEnabled || !ownerRun) return;
		if ((event.message as { role?: string })?.role !== "assistant") return;
		connect.beginDraft();
		draftText = "";
		lastDraftAt = 0;
	});
	pi.on("message_update", async (event) => {
		if (!connect || !draftPreviewsEnabled || !ownerRun) return;
		const text = extractText(
			(event.message as { content?: unknown }).content as never,
		);
		if (!text || text === draftText) return;
		// The reply has started: retire the placeholder BEFORE the first chunk, or its
		// refresh timer would overwrite the streaming text with "Thinking…" again.
		stopThinking();
		draftText = text;
		const now = Date.now();
		if (now - lastDraftAt < DRAFT_THROTTLE_MS) return;
		lastDraftAt = now;
		await connect.streamDraft(text);
	});
	// Deliver each assistant message as it completes, not just the run's last one:
	// while working the model narrates, calls tools, answers, and often adds a
	// trailing "done" — mirroring only the last text sent that trailing line and
	// dropped the answer. This is also the live trace of it working.
	pi.on("message_end", async (event) => {
		if (!connect || !ownerRun) return;
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const text = extractText(message.content as never);
		if (!text?.trim()) return;
		const controller = connect;
		const delivered = chatLane.run(async () => {
			// Erase the draft — the trace, or the streamed preview of this very reply —
			// before the real message lands, or it stays sitting ABOVE the answer it was
			// previewing.
			await dropPlaceholder(controller);
			await controller.deliverAssistant(text);
			// The model may still be working (an answer, then more tools). If it is, the
			// trace comes back BELOW the message it just sent.
			raisePlaceholder();
		});
		mirroredThisRun = true;
		notePersonalActivity();
		// The answer is ready, but the step before it is still being sent — a full-output
		// log can take seconds to upload, and it goes FIRST on purpose. Say what the reply
		// is waiting on, instead of leaving a finished draft sitting there looking stuck.
		if (chatLane.pending() > 1) showSendingOutput();
		await delivered.catch(() => {});
	});

	// Mirror prompts typed at the Pi terminal into Telegram for a unified history.
	// We key off Pi's own provenance (InputEvent.source) — our Telegram injections
	// arrive as "extension" and are not mirrored, so there is no echo loop.
	pi.on("input", async (event) => {
		const origin = classifyInputSource(event.source);
		if (connect && shouldMirrorToTelegram(origin)) {
			notePersonalActivity();
			await connect.mirrorTerminalInput(event.text).catch(() => {});
		}
		// Mixed mode: a prompt the owner typed at the terminal is the priority
		// signal. Take the shared brain back for coding at once — cancel the return
		// timer and, if the manager was mid-turn in the Telegram polarity, abort it
		// so the owner never waits on a moderation reply. Our own Telegram injections
		// arrive as "external" and are ignored here.
		if (mixedActive && origin === "terminal") await takeSessionForCoding();
		return { action: "continue" };
	});

	/**
	 * Compact the context on the owner's ask (`/compact` in the chat).
	 *
	 * `ctx.compact()` returns immediately and reports back on a callback. Success is
	 * already narrated by the two events below, so only the FAILURE needs a card of its
	 * own: without one, a compaction that threw left "Compacting context…" standing as
	 * the last word in the chat, with nothing ever following it.
	 */
	const compactContext = async (): Promise<void> => {
		const ctx = activeCtx;
		const controller = connect;
		if (!ctx || !controller) return;
		// Compacting rewrites the history the running turn is reading from. Wait for the
		// turn to finish, exactly as /clear does.
		if (busy) {
			await controller
				.sendToChat(
					card("⏳", "Busy right now", [
						note("Send /compact again once I finish."),
					]),
				)
				.catch(() => {});
			return;
		}
		ctx.compact({
			onError: (error) => {
				void chatLane
					.run(() => controller.sendToChat(compactionFailedCard(error.message)))
					.catch(() => {});
			},
		});
	};

	// Narrate compaction, whoever started it: the owner (/compact), the context
	// threshold, or an overflow recovery. It rewrites what the model remembers and takes
	// long enough that saying nothing reads as a hang.
	//
	// It is also the ONE path that reads the session without asking us what the model
	// may see: `pi.on("context")` does not run for a compaction. In mixed mode that
	// matters — the manager's Telegram turns share the session with the owner's coding
	// thread — so the moderation turns come out of the summary here, before it is
	// written. See `stripTelegramTurnsFromCompaction`.
	pi.on("session_before_compact", async (event, ctx) => {
		// A compaction runs INSIDE `prompt()`, ahead of the turn it delays, and on a local
		// model it takes minutes. `deliverPrompt` reads this so it waits for the turn
		// instead of concluding the prompt was thrown away and sending it a second time.
		compactingSince = Date.now();
		// The material, first — including for the fallback path below, where Pi summarises
		// `preparation` itself and never asks us anything again.
		if (mixedActive) stripTelegramTurnsFromCompaction(event.preparation);
		if (connect) {
			const controller = connect;
			await chatLane
				.run(() =>
					controller.sendToChat(
						compactingCard(event.reason, ctx.getContextUsage()),
					),
				)
				.catch(() => {});
		}
		// Then the summary itself. Pi's automatic compaction — the one that actually fires
		// in a long session — tells the summariser nothing, so it weighs the conversation
		// by mass and keeps the tool output, which is four fifths of it, over the person,
		// who is two percent of it. We run the same `compact()` Pi would have run, with the
		// one argument its automatic path leaves empty. Undefined = Pi compacts as usual.
		const compaction = await runFocusedCompaction({
			thread: manager ? (mixedActive ? "mixed" : "manager") : "personal",
			model: ctx.model,
			preparation: event.preparation,
			callerInstructions: event.customInstructions,
			signal: event.signal,
			auth: (model) => ctx.modelRegistry.getApiKeyAndHeaders(model),
			compact: (args) =>
				compact(
					args.preparation,
					args.model,
					args.apiKey,
					args.headers,
					args.customInstructions,
					args.signal,
				),
		});
		return compaction ? { compaction } : undefined;
	});
	pi.on("session_compact", async (event) => {
		compactingSince = 0;
		// Remembered, not just announced: a compaction is the answer to "why did it
		// forget the beginning", and that question is asked hours later, when the card
		// has scrolled away. /context still says so.
		lastCompaction = {
			at: Date.now(),
			tokensBefore: event.compactionEntry.tokensBefore,
		};
		const controller = connect;
		if (!controller) return;
		await chatLane
			.run(() =>
				controller.sendToChat(
					compactedCard(event.compactionEntry.tokensBefore),
				),
			)
			.catch(() => {});
	});
	pi.on("session_shutdown", async () => {
		// No goodbye card: the pinned mode line is the one place that says whether the
		// bridge is up, and it now flips to "Stopped" here. A card said the same thing
		// once, then stayed in the chat saying it forever.
		if (connect || manager) await updateModePin("stop");
	});

	// Both mode launchers load settings, surface any warnings, and need the bot
	// token; this centralises that and bails (returning null) with a clear message
	// when the token is unset.
	const loadSettingsAndToken = async (
		ctx: ExtensionCommandContext,
	): Promise<{ settings: TelegramSettings; token: string } | null> => {
		const { settings, warnings } = await loadSettings(fs, paths.settingsPath);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		activeTimezone = settings.timezone;
		activeSettings = settings;
		const token = resolveSecret(settings.botToken);
		if (!token) {
			ctx.ui.notify(
				'Set botToken in settings.json (or "env:TELEGRAM_BOT_TOKEN" to read it from the environment).',
				"error",
			);
			return null;
		}
		return { settings, token };
	};

	// Split the owner's DM into a `chat` topic (the conversation) and a `log` topic
	// (feed, tool activity, notices). Best-effort and shared by both modes: without
	// topic mode on the bot every thread id stays undefined and the DM behaves exactly
	// as before, so a start is never blocked by this.
	const setupTopics = async (
		api: unknown,
		ownerChatId: number,
		settings: TelegramSettings,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		topics = new TopicRouter({
			api: api as TopicsApi,
			fs,
			path: paths.topicsPath,
			ownerChatId,
			options: settings.topics,
			onFallback: (reason) => {
				ctx.ui.notify(reason, "warning");
				// The TUI notice is invisible to someone driving the bot from a phone —
				// which is the whole point of this extension. Say it where they ARE: in
				// the DM that is about to become one undivided stream.
				if (!settings.topics.enabled) return;
				void (api as ControlApi)
					.sendMessage({
						chat_id: ownerChatId,
						text: TOPICS_SETUP_NOTICE,
						link_preview_options: { is_disabled: true },
					})
					.catch(() => {});
			},
		});
		await topics.ensure();
	};

	/**
	 * Start this session in a brand-new `personal` topic (see TopicRouter.startSession
	 * for what we measured and why). Only where the conversation actually lives: personal
	 * and mixed. The manager never talks in `personal` — it only pins the mode line there
	 * — so rotating on its start would burn topics for nothing.
	 */
	const rotatePersonalTopic = async (): Promise<void> => {
		if (!topics?.active) return;
		await topics.startSession();
	};

	/** Anything said in `personal` — so the next session archives it instead of dropping it. */
	const notePersonalActivity = (): void => {
		void topics?.markUsed().catch(() => {});
	};

	/**
	 * The connected business accounts. One store for the whole extension: the manager
	 * writes it, the "not connected" check and the feed's owner-chat lookup read it.
	 */
	const businessStore = createBusinessStore(fs, paths.businessPath);

	/** Connection ids we already tried to resolve, so one unknown id asks Telegram once. */
	const learnedConnections = new Set<string>();

	/**
	 * Resolve a connection id seen in traffic into the real `BusinessConnection` and
	 * persist it. `business_connection` updates arrive only on CHANGE, so a bot that
	 * was connected before its first run has nothing stored — and the store is what
	 * tells the manager who the OWNER is. `getBusinessConnection` (Bot API 7.2) turns
	 * the id every business message carries into that record. Best-effort: a failure
	 * leaves the manager on its `ownerUserId` fallback.
	 */
	const learnBusinessConnection = async (
		connectionId: string,
	): Promise<void> => {
		if (!manager || !managerClient || learnedConnections.has(connectionId)) {
			return;
		}
		learnedConnections.add(connectionId);
		if (await businessStore.get(connectionId)) return;
		try {
			const api = managerClient.api as unknown as {
				getBusinessConnection(args: {
					business_connection_id: string;
				}): Promise<BusinessConnection>;
			};
			const connection = await api.getBusinessConnection({
				business_connection_id: connectionId,
			});
			await manager.onBusinessConnection({
				connectionId,
				connection,
				isEnabled: connection.is_enabled ?? true,
			});
		} catch {
			// Older API server, or the connection vanished: allow a later retry.
			learnedConnections.delete(connectionId);
		}
	};

	/**
	 * Tell the owner what the bot was NOT given, in the DM where they will actually
	 * see it. A missing toggle is invisible from the inside: the manager simply never
	 * receives a chat, or receives them and cannot answer — both look like a bug in
	 * this extension rather than a setting nobody flipped. Checked on every manager /
	 * mixed start; best-effort, never blocks the start.
	 */
	/**
	 * Say something to the owner in their own DM (and in the terminal). Unlike the
	 * startup check, this fires from live traffic, where there is no Pi command
	 * context — it rides the manager client and the owner id captured on mode start.
	 * Best-effort: a diagnostic must never break the update it rode in on.
	 */
	const notifyOwner = async (
		text: string,
		level: "info" | "warning" = "warning",
	): Promise<void> => {
		activeCtx?.ui.notify(text.split("\n")[0] ?? text, level);
		const api = managerClient?.api as unknown as ControlApi | undefined;
		if (!api || ownerUserId === null) return;
		await api
			.sendMessage({
				chat_id: ownerUserId,
				text,
				link_preview_options: { is_disabled: true },
			})
			.catch(() => {});
	};

	const checkSecretarySetup = async (
		api: unknown,
		ownerChatId: number,
		store: BusinessStore,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const control = api as ControlApi & {
			getMe(): Promise<{ can_connect_to_business?: boolean }>;
		};
		const warn = async (text: string): Promise<void> => {
			ctx.ui.notify(text.split("\n")[0] ?? text, "warning");
			await control
				.sendMessage({
					chat_id: ownerChatId,
					text,
					link_preview_options: { is_disabled: true },
				})
				.catch(() => {});
		};
		try {
			const me = await control.getMe();
			if (!me.can_connect_to_business) {
				await warn(SECRETARY_SETUP_NOTICE);
				return;
			}
			const connections = await store.all();
			const enabled = connections.filter((c) => c.isEnabled);
			if (enabled.length === 0) {
				// "No connection" cannot be judged at startup: Telegram delivers the
				// business_connection update on CHANGE, so a bot connected long ago has
				// nothing to redeliver, and traffic is the only proof. Ask again later,
				// and only if nothing from the Secretary side has arrived by then.
				armNotConnectedCheck(store, warn);
				return;
			}
			// `canReply` is undefined on older connections we stored before the field
			// existed; only an explicit false is a real problem. ANY muted connection is
			// worth saying out loud: with `every`, a second working account silenced the
			// warning for the broken one, which is precisely the case you cannot see from
			// the inside.
			const muted = enabled.filter((c) => c.canReply === false);
			if (muted.length > 0) {
				const named =
					muted.length === enabled.length
						? REPLY_RIGHT_NOTICE
						: `${REPLY_RIGHT_NOTICE}\n\nAffected account(s): ${muted
								.map((c) => c.userName ?? c.userId)
								.join(", ")}`;
				await warn(named);
			}
		} catch {
			// A probe failure is not worth blocking a mode start over.
		}
	};

	/**
	 * The grace period before we claim the bot is not connected: any Secretary traffic
	 * (a connection update, a message from a managed chat) proves it is, and cancels
	 * the claim.
	 */
	const NOT_CONNECTED_GRACE_MS = 60_000;
	let notConnectedTimer: ReturnType<typeof setTimeout> | null = null;
	let secretaryTrafficSeen = false;

	const armNotConnectedCheck = (
		store: BusinessStore,
		warn: (text: string) => Promise<void>,
	): void => {
		if (notConnectedTimer) clearTimeout(notConnectedTimer);
		notConnectedTimer = setTimeout(() => {
			notConnectedTimer = null;
			if (secretaryTrafficSeen || !manager) return;
			void store.all().then((connections) => {
				if (connections.some((c) => c.isEnabled)) return;
				void warn(NOT_CONNECTED_NOTICE);
			});
		}, NOT_CONNECTED_GRACE_MS);
	};

	const cancelNotConnectedCheck = (): void => {
		secretaryTrafficSeen = true;
		if (notConnectedTimer) {
			clearTimeout(notConnectedTimer);
			notConnectedTimer = null;
		}
	};

	const personalThread = (): number | undefined => topics?.thread("personal");
	const managerThread = (): number | undefined => topics?.thread("manager");

	/** The topic an inbound message was posted in (undefined without topics). */
	const threadOf = (event: TelegramEvent): number | undefined =>
		event.kind === "message" || event.kind === "edited_message"
			? event.message.message_thread_id
			: undefined;

	/**
	 * Take an owner message as the conversation, wherever it was typed — and repair the
	 * topics when it arrives from somewhere unexpected.
	 *
	 * EVERY message the owner types in their own DM is a message to their bot: there is
	 * nobody else in that chat. So none is ignored — not the one typed in the plain DM
	 * after they DELETED the topics (which used to be swallowed in silence, the router
	 * still pointing at a dead thread), and not the one typed in the `manager` feed.
	 * The feed is where the bot reports to itself, so the owner's line there gets moved
	 * out into `personal` rather than left to look like part of the report — the same
	 * treatment the "All" view gets. The bot's OWN cards in that feed are never touched:
	 * a private chat delivers no updates for what the bot posted itself.
	 *
	 * A message with NO thread is one typed OUTSIDE the topics — the "All" view, where
	 * Telegram itself labels the input box "message outside a topic". Live proof: a
	 * message typed inside `personal` arrives with `message_thread_id` set to it and
	 * `is_topic_message=true`, so the absence is not silence, it is the answer.
	 */
	const acceptAsPersonal = async (event: TelegramEvent): Promise<void> => {
		if (!topics?.active) return;
		const place = placeOfOwnerMessage({
			thread: threadOf(event),
			isTopicMessage:
				event.kind === "message" || event.kind === "edited_message"
					? event.message.is_topic_message
					: undefined,
			personal: personalThread(),
			ours: topics.ownThreads,
		});
		notePersonalActivity();
		if (place === "personal") return;
		// A topic we do not know may be one the owner made — or ours, deleted and
		// replaced. Re-check ours (recreating whatever is gone) before answering.
		if (place === "topic") await topics.revalidate();
		// Ours to tidy (`manager`, the archive, the "All" view) → the message is MOVED.
		// A topic the owner made is theirs → it is only copied.
		noteStray(event, place !== "topic");
	};

	/**
	 * Messages typed outside the personal topic, waiting for the turn that answers them.
	 *
	 * Telegram cannot MOVE a message between topics, so the question stays where it was
	 * typed while the answer goes to `personal` — leaving the topic reading as if the
	 * bot talked to itself. Quoting the far message across topics was tried and
	 * abandoned (no two clients agreed on what the quote meant), so a COPY is forwarded
	 * into `personal` instead.
	 *
	 * The copy is made when the turn STARTS, not when the message lands: a message may
	 * still be waiting for an album to close, be folded into a burst of forwards, or be
	 * followed by three more sentences — copying each on arrival filled the topic with
	 * forwards before the bot had even begun to think. One turn, one copy of what it
	 * actually answers, right as the answer starts being written.
	 *
	 * The value says whether the ORIGINAL is then removed — and that depends on where it
	 * was typed. The "All" view is not a place: nothing lives there. The bot's own topics
	 * (`manager`, the archive) are not places for the owner to write either — they are
	 * its furniture. From both, the message is MOVED. A topic the owner made themselves IS
	 * a place, theirs, and the bot has no business emptying it: from there it is copied.
	 */
	const strayMessages = new Map<number, { moveOut: boolean }>();

	const noteStray = (event: TelegramEvent, moveOut: boolean): void => {
		if (event.kind !== "message") return;
		// A command (/clear, /help) is an instruction to the bridge, not a line of the
		// conversation — the topic needs no record of it.
		if ((event.message.text ?? "").startsWith("/")) return;
		strayMessages.set(event.message.message_id, { moveOut });
		// Bound it: turns claim their own, so this only holds the ones no turn came for.
		if (strayMessages.size > MAX_STRAY_MESSAGES) {
			const oldest = strayMessages.keys().next();
			if (!oldest.done) strayMessages.delete(oldest.value);
		}
	};

	/**
	 * Bring the messages this turn answers into `personal`: copy each one there, and —
	 * only for those typed in the "All" view — remove the original, so the question is
	 * MOVED rather than duplicated. "Bots can delete incoming messages in private chats"
	 * is the one lever Telegram gives us for that.
	 *
	 * A message from a topic the OWNER made is copied and left alone. That topic is
	 * theirs — notes, a scratch thread, whatever they built it for — and a bot that
	 * empties it to keep its own conversation tidy is a bot that deletes your things.
	 * The copy is enough: `personal` still reads as a whole conversation.
	 *
	 * The delete happens only once the copy is safely there, so a failed forward costs
	 * nothing: the message stays where it is and is answered from `personal`, as before.
	 * (Telegram refuses to delete anything older than 48 hours; ignored for the same
	 * reason.)
	 */
	const mirrorStraysIntoPersonal = async (
		sourceMessageIds: readonly number[],
	): Promise<void> => {
		const api = controlApi();
		const personal = personalThread();
		if (!api || personal === undefined || ownerUserId === null) return;
		const owner = ownerUserId;
		for (const messageId of sourceMessageIds) {
			const stray = strayMessages.get(messageId);
			if (!stray) continue;
			strayMessages.delete(messageId);
			const copied = await api
				.forwardMessage({
					chat_id: owner,
					message_thread_id: personal,
					from_chat_id: owner,
					message_id: messageId,
				})
				.then(() => true)
				.catch(() => false);
			if (!copied || !stray.moveOut) continue;
			await api
				.deleteMessage({ chat_id: owner, message_id: messageId })
				.catch(() => {});
		}
	};

	/**
	 * Make room for the mode about to start: a mode command IS a switch. Running one
	 * while another is active used to just warn ("a Telegram mode is already active"),
	 * leaving you to stop it by hand; now the running mode is torn down first — the same
	 * thing the Telegram switch buttons do. Returns false when the wanted mode is
	 * already the live one (nothing to do).
	 */
	const takeOverFrom = async (
		ctx: ExtensionCommandContext,
		wanted: PanelMode,
	): Promise<boolean> => {
		const current = activeTarget();
		if (current === wanted) {
			ctx.ui.notify(`Telegram ${switchLabel(wanted)} is already active.`);
			return false;
		}
		if (current !== "stop") {
			// The owner's switch is a priority action: interrupt an in-flight turn (a long
			// consolidation, a reply) instead of waiting for it.
			await abort.abort();
			await stopAll();
			ctx.ui.notify(`Telegram: stopped ${switchLabel(current)}.`);
		}
		return true;
	};

	/**
	 * Build the personal (mode-1) runtime on an already-created bot client: the
	 * outbound sender, media intake, and the ConnectController itself, plus its
	 * system instructions. Shared by Personal mode and by mixed — where the owner's
	 * `chat` topic IS a second keyboard for the same session, so the bridge must
	 * behave identically there.
	 */
	const startConnectRuntime = async (
		telegram: TelegramClient,
		token: string,
		settings: TelegramSettings,
		ctx: ExtensionCommandContext,
		allowedUserId: number,
	): Promise<ConnectController> => {
		// Assemble mode-1 instructions: bundled connect.md plus the user's
		// global + connect override files (appended, never replacing defaults).
		const connectOverride = await readInstructionFiles(fs, [
			...settings.instructionFiles,
			...settings.connect.instructionFiles,
		]);
		for (const file of connectOverride.missing) {
			ctx.ui.notify(`Instruction file not found: ${file}`, "warning");
		}
		connectSystemBlock = await loadConnectInstructions({
			fs,
			overrideText: connectOverride.text,
		});

		// Warn once (not per-message) when native rich rendering isn't reaching
		// Telegram and we degraded to plain text — so a tester can tell a real
		// rich reply from a fallback one.
		let richFallbackWarned = false;
		const outbound = new OutboundSender(
			telegram.api as unknown as OutboundApi,
			{
				onRichFallback: (error) => {
					// The topic we addressed is gone (deleted mid-session): that is not a
					// rich-rendering problem. Recreate it right away — the next send then
					// lands in the fresh topic instead of the plain DM.
					if (TopicRouter.isMissingThread(error)) {
						if (topics?.active) {
							void topics.recreate("personal").then((thread) => {
								if (thread === undefined) {
									ctx.ui.notify(
										"The personal topic is gone and could not be recreated — using the plain DM.",
										"warning",
									);
								}
							});
						}
						return;
					}
					if (richFallbackWarned) return;
					richFallbackWarned = true;
					ctx.ui.notify(
						`Native rich rendering unavailable — sending plain text instead (${String(error)}).`,
						"warning",
					);
				},
			},
		);
		const media = new MediaDownloader({
			api: telegram.api as unknown as FileApi,
			fetchBytes: fetchBytesFromUrl,
			fileBaseUrl: fileBaseUrl(token),
			maxBytes: settings.files.maxBytes,
		});
		const loadImages = (message: Message) =>
			loadInlineImages(media, message, settings.files.maxBytes);
		// Where inbound non-image files land — a file you send the bot, or one you
		// REPLY to: the configured dir, else the directory Pi runs in. Same path parser
		// as every other configurable location, so `~/x`, `C:\x` and `\\srv\share`
		// mean the same thing everywhere.
		const downloadDir = resolveUserDir(
			settings.files.downloadDir,
			process.cwd(),
			homedir(),
		);
		// Save every non-image attachment to disk and report its absolute path,
		// so the model can open it with its normal tools. Per-file errors are
		// collected and surfaced in the prompt, not swallowed.
		const saveAttachments = async (
			message: Parameters<typeof describeAttachments>[0],
		) => {
			const refs = describeAttachments(message, settings.files.maxBytes).filter(
				(ref) => !isImage(ref),
			);
			const savedFiles: TurnSavedFile[] = [];
			const errors: string[] = [];
			const used = new Set<string>();
			for (const ref of refs) {
				const label = ref.fileName ?? ref.kind;
				try {
					const file = await media.download(ref);
					const target = join(downloadDir, resolveSaveName(ref, used));
					await fs.writeBytes(target, file.bytes);
					savedFiles.push({
						path: target,
						kind: ref.kind,
						size: formatBytes(file.bytes.length),
						mimeType: ref.mimeType,
					});
				} catch (error) {
					errors.push(`${label}: ${String(error)}`);
				}
			}
			return { savedFiles, errors };
		};
		// Upload a local file or URL back to the bound chat (the telegram_attach
		// tool). Validate a local path up front so the model gets a clear error.
		//
		// The file belongs in the `personal` topic, like every other half of this
		// conversation: sent thread-less it landed in the DM's catch-all instead, so
		// the model announced a file that was nowhere to be seen in the topic the
		// owner was reading. A dead thread is repaired and retried once, exactly as
		// the text sends do — a failed send is the only proof a topic was deleted.
		const uploadFile = async (input: {
			path?: string;
			url?: string;
			caption?: string;
			replyToMessageId?: number;
			filename?: string;
		}) => {
			if (input.path && !(await fs.exists(input.path))) {
				throw new Error(`file not found: ${input.path}`);
			}
			const send = (threadId: number | undefined) =>
				telegram.sendDocument({
					chatId: allowedUserId,
					threadId,
					...input,
				});
			try {
				await send(personalThread());
			} catch (error) {
				if (!topics?.active || !TopicRouter.isMissingThread(error)) throw error;
				await send(await topics.recreate("personal"));
			}
		};
		connect = new ConnectController({
			allowedUserId,
			maxBytes: settings.files.maxBytes,
			maxImages: settings.files.maxImagesPerTurn,
			isIdle: () => !busy,
			sendFollowUp,
			loadImages,
			saveAttachments,
			uploadFile,
			onClear: async () => {
				// Clearing mid-turn could orphan a tool_use/tool_result pair, so
				// only reset while the agent is idle.
				if (busy) {
					await connect?.sendToChat(
						card("⏳", "Busy right now", [
							note("Send /clear again once I finish."),
						]),
					);
					return;
				}
				contextReset.clear(Date.now());
				await connect?.sendToChat(
					card("🧹", "History cleared", [
						"Starting fresh.",
						note("Shared session: the terminal sees the cleared context too."),
					]),
				);
			},
			onCompact: compactContext,
			onStatus: buildStatus,
			onContextReport: buildContextReport,
			onAbort: async () => {
				await connect?.sendToChat(escapeCard(await escapeSession()));
			},
			onContact: async (user) => {
				await contactStore.upsertProfile(
					extractProfileFromUser(user),
					Date.now(),
				);
			},
			chatThread: personalThread,
			onTurnVisible: mirrorStraysIntoPersonal,
			forwards: settings.forwards,
			timezone: settings.timezone,
			outbound,
			abort,
		});
		toolActivityEnabled = settings.assistant.toolActivity;
		draftPreviewsEnabled = settings.assistant.draftPreviews;
		thinkingEnabled = settings.assistant.thinkingPlaceholder;
		toolOutputMaxBytes = settings.assistant.toolOutputMaxBytes;
		toolOutputDir = resolveUserDir(
			settings.assistant.toolOutputDir,
			paths.toolOutputDir,
			homedir(),
		);
		visibility.setActive("connect", true);
		return connect;
	};

	/**
	 * The owner just acted (typed at the terminal, or wrote in the `chat` topic) —
	 * the priority signal in mixed mode. Take the shared brain back for coding at
	 * once: cancel the return timer and, if the manager was mid-turn in the Telegram
	 * polarity, abort it so the owner never waits on a moderation reply.
	 */
	const takeSessionForCoding = async (): Promise<void> => {
		if (!mixedActive) return;
		cancelMixedReturnTimer();
		const wasTelegram = polarity === "telegram";
		setPolarity("coding");
		if (wasTelegram) await abort.abort();
	};

	// Mode-1 launcher, extracted from the command handler so `switchMode` can start
	// it from a Telegram button press too. Captures `activeCtx`/`ownerUserId` for the
	// control panel.
	/**
	 * Refuse to start on a broken installation.
	 *
	 * The bundled Markdown IS the bot's rulebook. Missing, the manager would once have
	 * started with an empty one — no disclosure duty, no stance — and gone on answering
	 * real people. Checked here, first, while there is still nothing to unwind: no
	 * singleton claimed, no client opened.
	 */
	const installationIsComplete = async (
		ctx: ExtensionCommandContext,
	): Promise<boolean> => {
		try {
			await verifyBundledInstructions(fs);
			return true;
		} catch (error) {
			ctx.ui.notify(String((error as Error).message ?? error), "error");
			return false;
		}
	};

	const startConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		activeCtx = ctx;
		if (!(await installationIsComplete(ctx))) return;
		if (!(await takeOverFrom(ctx, "personal"))) return;
		const loaded = await loadSettingsAndToken(ctx);
		if (!loaded) return;
		const { settings, token } = loaded;
		if (!settings.allowedUserId) {
			ctx.ui.notify("Set allowedUserId in settings.json first.", "error");
			return;
		}
		const allowedUserId = settings.allowedUserId;
		ownerUserId = allowedUserId;
		const activation = await lifecycle.activate({
			mode: "connect",
			chatId: String(allowedUserId),
		});
		if (!activation.ok) {
			ctx.ui.notify(`Cannot connect: ${activation.reason}`, "error");
			return;
		}

		client = new TelegramClient({
			token,
			onEvent: async (event) => {
				// /start is the way back in after the owner deletes the chat — it is what
				// re-posts the pinned mode line, so it must be handled here exactly as the
				// manager and mixed routers handle it. Personal mode used to skip this and
				// let the ConnectController answer /start on its own: the terms came back,
				// but the pin never did — in the one mode where a wiped chat is most likely.
				if (await handleStartCommand(event)) return;
				if (await handleControl(event)) return;
				// Whatever the owner types is the conversation, wherever they typed it —
				// the topics are only where it is filed (and repaired, if they deleted one).
				await acceptAsPersonal(event);
				await connect?.onEvent(event);
			},
			onError: (error) =>
				ctx.ui.notify(`Telegram error: ${String(error)}`, "error"),
		});
		await setupTopics(client.api, allowedUserId, settings, ctx);
		await rotatePersonalTopic();
		await startConnectRuntime(client, token, settings, ctx, allowedUserId);
		void client.start();
		// Publish the tappable command menus (no manual setup needed by the user).
		// Two scopes, deliberately: the control commands are refused to everyone but
		// the owner, so publishing them by default only offered strangers a "Stop the
		// bot entirely" button that does nothing. They get /start; the owner gets the
		// bridge.
		void publishCommandMenus(client.api, allowedUserId);
		heartbeat = setInterval(() => {
			void lifecycle.heartbeat();
		}, HEARTBEAT_INTERVAL_MS);
		// The queue used to be pumped only by the events that normally follow a message:
		// the turn ending, or the next message arriving. When a hand-off fails — a session
		// that will not go idle — neither of those ever comes, and the message waits
		// forever for its own delivery. So the pump also has a beat of its own.
		queuePump = setInterval(() => {
			void connect?.dispatch().catch(() => {});
		}, QUEUE_PUMP_MS);
		armWatchdog(settings);
		ctx.ui.setStatus(
			STATUS_KEY,
			fitLine(`Telegram: connected (chat ${allowedUserId})`, terminalWidth()),
		);
		modeStartedAt = Date.now();
		ctx.ui.notify("Telegram connect: active.");
		// The pin IS the connection notice, in every mode — a separate "Connected"
		// card would say the same thing twice, and only personal mode ever sent one.
		await updateModePin("personal");
	};

	pi.registerCommand(COMMANDS.status, {
		description: "Show the Telegram bridge status.",
		handler: async (_args, ctx) => {
			const active = await lifecycle.resolveActive();
			if (!active) {
				ctx.ui.notify("Telegram: inactive.");
				return;
			}
			const queued = connect ? `, ${connect.pendingCount()} queued` : "";
			ctx.ui.notify(`Telegram: ${active.mode} active${queued}.`);
		},
	});

	// Shared launcher for the manager and for mixed mode (`mixed: true`), which runs
	// the same manager runtime alongside the owner's coding thread in one session.
	const startManager = async (
		ctx: ExtensionCommandContext,
		options: { mixed?: boolean } = {},
	): Promise<void> => {
		const mixed = options.mixed === true;
		activeCtx = ctx;
		if (!(await installationIsComplete(ctx))) return;
		const wanted: PanelMode = mixed ? "mixed" : "manager";
		if (!(await takeOverFrom(ctx, wanted))) return;
		const loaded = await loadSettingsAndToken(ctx);
		if (!loaded) return;
		const { settings, token } = loaded;
		ownerUserId = settings.allowedUserId ?? null;
		// Prime mixed-mode state before anything reads it (context handler, isIdle):
		// the owner is at the keyboard when they launch it, so start in the coding
		// polarity with the return timer disarmed until the first coding turn ends.
		mixedActive = mixed;
		if (mixed) {
			polarity = "coding";
			mixedReturnMs = settings.mixed.returnToTelegramMs;
		}

		const activation = await lifecycle.activate({
			mode: mixed ? "mixed" : "manager",
			workdir: mixed ? ctx.cwd : paths.managerWorkspaceDir,
		});
		if (!activation.ok) {
			mixedActive = false;
			ctx.ui.notify(
				`Cannot start ${mixed ? "mixed" : "manager"}: ${activation.reason}`,
				"error",
			);
			return;
		}

		// Assemble the manager's system instructions: the bundled defaults plus any
		// user override files (global + manager).
		const overrideFiles = [
			...settings.instructionFiles,
			...settings.manager.instructionFiles,
		].filter((file): file is string => Boolean(file));
		const override = await readInstructionFiles(fs, overrideFiles);
		for (const file of override.missing) {
			ctx.ui.notify(`Instruction file not found: ${file}`, "warning");
		}
		const firstMessageOverride = settings.manager.firstMessageTemplate
			? (
					await readInstructionFiles(fs, [
						settings.manager.firstMessageTemplate,
					])
				).text || undefined
			: undefined;
		const reopenOverride = settings.manager.reopenTemplate
			? (await readInstructionFiles(fs, [settings.manager.reopenTemplate]))
					.text || undefined
			: undefined;
		// The effective wake-word list = configured mentionWords + the bot's own
		// label as a phrase, so addressing the bot by the name it signs with also
		// wakes it. Computed once and used for both the instructions and the runtime.
		const effectiveMentionWords = withLabelerMention(
			settings.manager.mentionWords,
			settings.manager.labeler,
		);
		const instructions = await loadManagerInstructions({
			fs,
			labeler: settings.manager.labeler,
			mentionWords: effectiveMentionWords,
			overrideText: override.text,
			firstMessageOverride,
			reopenOverride,
		});

		// The telegram-sandbox allowlist: only the manager's messaging tools, plus
		// any user-configured regex names. Everything else (read/write/bash,
		// ask_user, foreign extensions) is hidden by visibility and blocked by the
		// runtime guard.
		const baseMatcher = createToolMatcher(
			MANAGER_TOOLS,
			settings.manager.allowedTools,
			(warning) => ctx.ui.notify(warning, "warning"),
		);
		// manager_resolve_draft belongs to the manager group (so it is hidden whenever
		// the manager is inactive) but is visible ONLY on a revise turn. On a revise
		// turn it is the SOLE active tool — reply/silent/remember are hidden — so the
		// model must resolve the held draft (send/refine/drop) and cannot spin calling
		// a tool the gate ignores. On any other turn it is hidden and the normal
		// sandbox applies. The matcher gates both the visibility gate and the runtime
		// guard on the live revise state, recomputed before each request.
		managerMatcher = {
			matches: (name) =>
				(manager?.isReviseTurn() ?? false)
					? name === MANAGER_RESOLVE_TOOL_NAME
					: name !== MANAGER_RESOLVE_TOOL_NAME && baseMatcher.matches(name),
		};

		// NOTE: we deliberately do NOT ctx.switchSession() here. switchSession is
		// terminal — it staleness-poisons the captured `ctx` and the module-level
		// `pi`, but the manager needs `pi.sendUserMessage` on every turn from the
		// polling loop. So the manager runs in the current session; per-chat
		// isolation is guaranteed by pi.on("context") rebuilding messages, and the
		// banner tells the user this session is now the manager.

		// One-off memory migration: wipe pre-v2 contact facts (captured without
		// subject attribution, so mis-attributed under the who-is-who firewall).
		// Runs once, guarded by the version marker; failure never blocks the manager.
		if (
			await migrateMemory(fs, paths.memoryVersionPath, contactStore).catch(
				() => false,
			)
		) {
			ctx.ui.notify(
				"Memory upgraded: previous contact facts were cleared.",
				"warning",
			);
		}

		// Bound each chat transcript on disk to the last-N window the model reads
		// (rememberMessages); older messages are pruned so files never grow forever.
		const chatStore = createChatStore(
			fs,
			paths,
			settings.manager.rememberMessages,
		);
		const consolidationQueue = createConsolidationQueue(
			fs,
			paths.consolidationQueuePath,
		);
		managerClient = new TelegramClient({
			token,
			onEvent: routeManagerEvent,
			onError: (error) => {
				ctx.ui.notify(`Telegram error: ${String(error)}`, "error");
				mirrorManagerNotice?.("error", `Telegram error: ${String(error)}`);
			},
			// Keep the backlog: messages that arrived while the manager was offline
			// are redelivered on start, so the bot can catch up on what it missed
			// (mode 1 keeps the default drop — stale terminal commands are unwanted).
			dropPendingUpdates: false,
		});
		if (settings.allowedUserId) {
			await setupTopics(
				managerClient.api,
				settings.allowedUserId,
				settings,
				ctx,
			);
			// The manager lives or dies by two things nobody can see from inside the bot:
			// Secretary Mode, and the right to reply. Say so if either is missing.
			await checkSecretarySetup(
				managerClient.api,
				settings.allowedUserId,
				businessStore,
				ctx,
			);
			// Mixed is personal + manager, literally: the same ConnectController runs on
			// the manager's bot client, so the owner's `chat` topic is a second keyboard
			// for the very same session — a message there is exactly a prompt typed at
			// the terminal (and terminal prompts mirror back into it).
			if (mixed) {
				await rotatePersonalTopic();
				await startConnectRuntime(
					managerClient,
					token,
					settings,
					ctx,
					settings.allowedUserId,
				);
			}
		}
		// Download an interlocutor message's inline images so the model can scan
		// them (mode-2 vision); documents are never downloaded here (refused by the
		// controller's media policy). Per-image failures are swallowed — the
		// "[image]" marker still records that a picture arrived.
		const managerMedia = new MediaDownloader({
			api: managerClient.api as unknown as FileApi,
			fetchBytes: fetchBytesFromUrl,
			fileBaseUrl: fileBaseUrl(token),
			maxBytes: settings.files.maxBytes,
		});
		// Download an interlocutor message's inline images so the model can scan
		// them (mode-2 vision); documents are refused by the controller's media
		// policy and never reach here.
		const loadManagerImages = (message: Message) =>
			loadInlineImages(managerMedia, message, settings.files.maxBytes);
		const api = managerClient.api as unknown as {
			sendChatAction(args: {
				business_connection_id: string;
				chat_id: number;
				action: "typing";
			}): Promise<unknown>;
		};
		// Deliver manager replies through the SAME rich pipeline as mode 1, so the
		// model's Markdown (**bold**, tables, …) renders natively instead of arriving
		// as literal asterisks. Warn once if native rich rendering degrades to plain.
		let managerRichFallbackWarned = false;
		const managerOutbound = new OutboundSender(
			managerClient.api as unknown as OutboundApi,
			{
				onRichFallback: (error) => {
					if (managerRichFallbackWarned) return;
					managerRichFallbackWarned = true;
					ctx.ui.notify(
						`Native rich rendering unavailable — sending plain text instead (${String(error)}).`,
						"warning",
					);
				},
			},
		);
		manager = new ManagerController({
			instructions,
			labeler: settings.manager.labeler,
			rememberMessages: settings.manager.rememberMessages,
			maxCharsPerMessage: settings.manager.maxCharsPerMessage,
			maxContextChars: settings.manager.maxContextChars,
			forwards: settings.forwards,
			continueWindowMs: settings.manager.continueWindowMs,
			ownerReplyWindowMs: settings.manager.ownerReplyWindowMs,
			factsLimit: settings.manager.factsLimit,
			factConsolidationQuietMs: settings.manager.factConsolidationQuietMs,
			verifyLimit: settings.manager.verifyLimit,
			liveFreshnessMs: settings.manager.liveFreshnessMs,
			reopenAfterMs: settings.manager.reopenAfterMs,
			reviseThreshold: settings.manager.reviseThreshold,
			ownerUserId: settings.allowedUserId
				? String(settings.allowedUserId)
				: undefined,
			ownerName: settings.manager.ownerName,
			strictReplyGuard: settings.manager.strictReplyGuard,
			mentionWords: effectiveMentionWords,
			timezone: settings.timezone,
			maxBytes: settings.files.maxBytes,
			maxImages: settings.files.maxImagesPerTurn,
			media: settings.manager.media,
			loadImages: loadManagerImages,
			clock: { now: () => Date.now() },
			chatStore,
			contactStore,
			consolidationQueue,
			sentRegistry: createSentRegistry(fs, paths.sentRegistryPath),
			businessStore,
			// In mixed mode the manager may only run a turn while the shared brain is
			// in the Telegram polarity; during coding the owner owns the session, so
			// the manager stays "not idle" — it keeps ingesting/deferring but never
			// triggers a turn until the return timer flips polarity.
			isIdle: () => !busy && managerHoldsSession(mixedActive, polarity),
			triggerAgent: async (prompt) => {
				// Tag every injected Telegram turn in mixed mode so the coding-polarity
				// context filter can strip it from the owner's thread.
				const content = mixedActive ? tagTelegramPrompt(prompt) : prompt;
				// Through `deliverPrompt`, so a turn injected while the session is still
				// settling cannot land in the SDK queue — from which the next abort would
				// dump it into the terminal editor instead of answering anyone.
				//
				// `deliverPrompt` THROWS when the session will not go idle, and this call
				// sits under the manager's 5-second tick (`void onTick().then(…)`) — an
				// escaping rejection there is an unhandled rejection, which ends the Pi
				// process. It is not the tick's job to die for a session that is wedged:
				// the chat stays unserved, so the very next tick tries again, and the owner
				// is told once (see `noteSessionStuck`).
				await deliverPrompt(content).catch(() => {});
			},
			// Business connections reject the rich-message API, so mode-2 replies go out
			// as classic HTML (parse_mode) with the labeler rendered as a blockquote.
			sendReply: async ({ connectionId, chatId, text, replyToMessageId }) =>
				managerOutbound.sendClassicHtml(
					{
						chatId: Number(chatId),
						businessConnectionId: connectionId,
						replyToMessageId,
					},
					formatManagerReplyHtmlChunks(
						text,
						settings.manager.labeler,
						settings.manager.labelerRule,
					),
				),
			typing: async ({ connectionId, chatId }) => {
				await api.sendChatAction({
					business_connection_id: connectionId,
					chat_id: Number(chatId),
					action: "typing",
				});
			},
		});
		// The bot account is idle in mode 2, so with `manager.log` on it doubles as an
		// observability channel: each turn (and runtime warnings/errors) is mirrored
		// to the owner's private chat with the bot — into the `log` topic when topics
		// are live, the plain DM otherwise — sent AS the bot (no business connection),
		// so it never leaks into the managed conversation.
		if (settings.manager.log) {
			// Resolve the owner's private-chat id. `allowedUserId` is the configured
			// owner and the exact DM mode 1 talks to, so it is the reliable target —
			// the business store can be empty (the manager runs off each message's
			// connectionId, so no business_connection is guaranteed to be persisted).
			// Fall back to the stored connection's `user_chat_id` only if unset.
			const ownerChatId = async (): Promise<number | null> => {
				if (settings.allowedUserId) return settings.allowedUserId;
				const connections = await businessStore.all();
				const connection =
					connections.find((c) => c.isEnabled) ?? connections[0];
				const target = connection?.userChatId ?? connection?.userId;
				return target ? Number(target) : null;
			};
			const sendOwnerFeed = async (
				html: ReturnType<typeof buildManagerFeed>,
			): Promise<void> => {
				const chatId = await ownerChatId();
				if (chatId === null) return;
				try {
					await managerOutbound.notify(
						{ chatId, messageThreadId: managerThread() },
						html,
					);
				} catch (error) {
					// The manager topic is gone (the owner deleted it). A failed send is the
					// only reliable proof of that — so recreate the topic here and retry the
					// card in it, instead of quietly degrading the whole run to the plain DM
					// and never bringing the topic back.
					if (topics?.active && TopicRouter.isMissingThread(error)) {
						const thread = await topics.recreate("manager");
						await managerOutbound
							.notify({ chatId, messageThreadId: thread }, html)
							.catch(() => {});
						return;
					}
					if (topics?.active) {
						topics.fallBack();
						await managerOutbound.notify({ chatId }, html).catch(() => {});
						return;
					}
					if (!managerFeedWarned) {
						managerFeedWarned = true;
						ctx.ui.notify(
							`Debug feed could not reach the owner — open a DM with the bot and press Start. (${String(error)})`,
							"warning",
						);
					}
				}
			};
			deliverManagerFeed = async (log, thinking, tools) => {
				await sendOwnerFeed(
					buildManagerFeed({
						log,
						nowLine: formatNowLine(Date.now(), settings.timezone),
						thinking: thinking || undefined,
						tools,
					}),
				);
			};
			mirrorManagerNotice = (level, message) => {
				void sendOwnerFeed(
					buildManagerNotice(
						level,
						message,
						formatNowLine(Date.now(), settings.timezone),
					),
				);
			};
		}
		void managerClient.start();
		// Publish the tappable command menus (so /switch is reachable in mode 2 too).
		// Mode 2 is where the scoping earns its keep: this bot is answering strangers,
		// and its menu is not their business.
		if (settings.allowedUserId) {
			void publishCommandMenus(managerClient.api, settings.allowedUserId);
		}
		visibility.setExclusive("manager", managerMatcher);
		// Mixed starts in coding polarity, so the manager sandbox is inactive until
		// the return timer flips to Telegram; the standalone manager is always active.
		visibility.setActive("manager", managerHoldsSession(mixed, polarity));
		managerUi = { setWidget: ctx.ui.setWidget.bind(ctx.ui) };
		updateManagerBanner();
		// Smart catch-up: answer for the owner in chats left waiting (last message
		// not the owner's, older than the owner-reply window, still recent). Runs
		// once on activation; failures never block the manager.
		await catchUpOnActivation(
			manager,
			chatStore,
			businessStore,
			settings.manager,
		).catch(() => {});
		updateManagerBanner();
		managerTick = setInterval(() => {
			// A tick must never take the process with it: an escaping rejection here is an
			// unhandled rejection, and Node ends the process for one.
			void manager
				?.onTick()
				.then(updateManagerBanner)
				.catch(() => {});
		}, MANAGER_TICK_MS);
		managerHeartbeat = setInterval(() => {
			void lifecycle.heartbeat();
		}, HEARTBEAT_INTERVAL_MS);
		armWatchdog(settings);
		modeStartedAt = Date.now();
		if (mixed) {
			// Mixed shows the footer indicator in the TUI AND a pinned indicator in the
			// bot DM (so the bot chat reflects it too); arm the idle timer so an idle
			// owner hands the brain to Telegram on its own.
			updateMixedFooter();
			armMixedReturnTimer();
			ctx.ui.notify("Telegram mixed: active.");
			await updateModePin("mixed");
		} else {
			ctx.ui.notify("Telegram manager: active.");
			await updateModePin("manager");
		}
	};

	// Personal (mode 1): bind this terminal session to a single Telegram DM.
	pi.registerCommand(COMMANDS.personal, {
		description:
			"Bind this terminal session to a Telegram chat (personal mode).",
		handler: (_args, ctx) => startConnect(ctx),
	});
	// Business manager: answer other people on the owner's behalf.
	pi.registerCommand(COMMANDS.manager, {
		description: "Start the Telegram business manager (answer for you).",
		handler: async (_args, ctx) => {
			await startManager(ctx);
		},
	});
	// Mixed: coding + Telegram moderation share one session.
	pi.registerCommand(COMMANDS.mixed, {
		description: "Run coding and Telegram moderation together.",
		handler: async (_args, ctx) => {
			await startManager(ctx, { mixed: true });
		},
	});
	// Stop whichever Telegram mode is currently active.
	pi.registerCommand(COMMANDS.stop, {
		description: "Stop the active Telegram mode.",
		handler: async (_args, ctx) => {
			if (manager) {
				await updateModePin("stop");
				await stopManager();
				ctx.ui.notify("Telegram: stopped.");
			} else if (connect) {
				await connect
					.sendToChat(
						card("🔌", "Disconnected", [note("From the Pi terminal session.")]),
					)
					.catch(() => {});
				await updateModePin("stop");
				await stopConnect(ctx);
				ctx.ui.notify("Telegram: stopped.");
			} else {
				ctx.ui.notify("No Telegram mode is active.", "warning");
			}
		},
	});

	// ─── /switch: in-chat mode switcher ──────────────────────────────────────
	// The bot's DM doubles as a control surface: `/switch` (or the command-menu
	// button) opens an inline keyboard; a button press flips the whole runtime
	// between modes, tearing down the old poller and starting the new one. Owner
	// only, gated by `ownerUserId`.

	// Whichever bot client is currently polling exposes the control api (send
	// panel, answer callbacks, edit keyboards). Null when fully stopped.
	const controlApi = (): ControlApi | null =>
		((managerClient ?? client)?.api as unknown as ControlApi) ?? null;

	// The mode currently running, for the panel caption / pin ("stop" when idle).
	const activeTarget = (): PanelMode => {
		if (manager) return mixedActive ? "mixed" : "manager";
		if (connect) return "personal";
		return "stop";
	};

	// Stop every active mode (either or neither may be running).
	const stopAll = async (): Promise<void> => {
		if (manager) await stopManager();
		if (connect && activeCtx) await stopConnect(activeCtx);
	};

	// Start a specific mode using the captured command context.
	const startMode = async (
		target: SwitchTarget,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (target === "manager") {
			await startManager(ctx);
		} else if (target === "mixed") {
			await startManager(ctx, { mixed: true });
		} else if (target === "personal") {
			await startConnect(ctx);
		}
		// "stop" starts nothing.
	};

	// Flip the runtime to `target`: no-op if already there, else stop everything
	// and start the requested mode. Errors are surfaced, never thrown to the poller.
	const switchMode = async (target: SwitchTarget): Promise<void> => {
		const ctx = activeCtx;
		if (!ctx) return;
		if (activeTarget() === target) return;
		try {
			// The owner's switch is a priority action: interrupt any in-flight turn
			// (e.g. a long memory consolidation) so the switch takes effect at once
			// rather than waiting for the current inference to finish. The interrupted
			// work is safe to drop — an unfinished consolidation stays queued on disk
			// and an unanswered chat is recovered by catch-up when that mode resumes.
			await abort.abort();
			// Reflect a full stop on the pinned indicator while a client is still alive
			// (after teardown there is none to edit it); mode→mode updates the pin from
			// inside the new mode's start.
			if (target === "stop") await updateModePin("stop");
			await stopAll();
			await startMode(target, ctx);
		} catch (error) {
			ctx.ui.notify(`Switch failed: ${String(error)}`, "error");
		}
	};

	// Run the switch AFTER the current update settles: `bot.stop()` on the very
	// client whose middleware we're inside would otherwise wait on this handler and
	// deadlock. A macrotask hop lets the update finish first.
	const scheduleSwitch = (target: SwitchTarget): void => {
		setTimeout(() => {
			void switchMode(target);
		}, 0);
	};

	// Send a fresh mode-switcher panel to the owner's DM. Control output belongs with
	// the conversation, so with topics on it goes to the `chat` topic — except when
	// the owner asked from a topic themselves, where the answer stays in that topic.
	const sendSwitchPanel = async (
		api: ControlApi,
		threadId = personalThread(),
	): Promise<void> => {
		if (ownerUserId === null) return;
		const active = activeTarget();
		await api
			.sendMessage({
				chat_id: ownerUserId,
				message_thread_id: threadId,
				text: switchPanelText(active),
				reply_markup: buildSwitchKeyboard(active),
			})
			.catch(() => {});
	};

	// Keep a pinned message at the top of the owner's DM showing the active mode, so
	// the current mode is always visible without running a command. Pinned once, then
	// edited in place (no new pins per switch); "stop" shows the bot is off.
	//
	// It carries the time it last changed, which is not decoration: a reconnect in the
	// SAME mode is a real event for the person reading it ("is it up again?"), and
	// without a clock the pin would be rewritten with identical text and look frozen.
	// Best-effort — never blocks a mode start/stop.
	const modePinText = (target: PanelMode): string => {
		const at = formatClock(Date.now(), activeTimezone);
		if (target === "stop") {
			return `📌 Bot mode: ⏹️ Stopped\nStopped: ${at}\nUse /switch to start a mode.`;
		}
		return `📌 Bot mode: ${switchLabel(target)}\nActive since: ${at}\nUse /switch to change.`;
	};

	/**
	 * Announce the mode in the owner's DM as a single pinned message.
	 *
	 * This used to edit the message in place. That cannot be made reliable: clearing
	 * the chat wipes the owner's copy while Telegram goes on accepting edits to that
	 * message id and still reports it as the chat's pinned message — so the bot edited
	 * a ghost, concluded all was well, and posted nothing. An empty chat, no error, no
	 * pin. "The message exists" and "the owner can see it" are simply not the same
	 * fact, and nothing in the Bot API tells them apart.
	 *
	 * So the pin is not maintained, it is REPLACED: delete every mode message we
	 * remember (if any is still there), post a new one, pin it. Connecting, switching and stopping
	 * are each a real event the person should see arrive, the chat never collects more
	 * than one mode message, and an owner who unpinned or deleted it needs no special
	 * case — the next update simply posts one that exists.
	 *
	 * Best-effort: never blocks a mode start or stop, but a failure is reported rather
	 * than swallowed.
	 */
	const updateModePin = async (target: PanelMode): Promise<void> => {
		// Serialised: two updates at once (a switch racing a shutdown) would each read
		// the same "previous" id, delete it twice and post twice — leaving a message
		// nobody remembers, which is exactly the duplicate this is meant to prevent.
		modePinChain = modePinChain.then(() => runModePinUpdate(target));
		await modePinChain;
	};

	let modePinChain: Promise<void> = Promise.resolve();

	const runModePinUpdate = async (target: PanelMode): Promise<void> => {
		if (ownerUserId === null) return;
		await loadModePin(ownerUserId);
		const api = controlApi();
		if (!api) return;
		const owner = ownerUserId;
		const text = modePinText(target);

		// Post into the personal topic, rebuilding it when it turns out to be gone
		// (deleting the chat takes its topics with it).
		const post = async (): Promise<number> => {
			try {
				const sent = await api.sendMessage({
					chat_id: owner,
					message_thread_id: personalThread(),
					text,
				});
				return sent.message_id;
			} catch (error) {
				if (!topics?.active || !TopicRouter.isMissingThread(error)) throw error;
				const thread = await topics.recreate("personal");
				const sent = await api.sendMessage({
					chat_id: owner,
					message_thread_id: thread,
					text,
				});
				return sent.message_id;
			}
		};

		try {
			// Remove every mode message we know of, not just the last one. A delete that
			// fails is the normal case (deleted by hand, or with the chat), not an error —
			// we are about to replace it anyway.
			for (const messageId of modePinMessageIds) {
				await api
					.deleteMessage({ chat_id: owner, message_id: messageId })
					.catch(() => {});
			}
			modePinMessageIds = [];
			const messageId = await post();
			await saveModePin(owner, [messageId]);
			await api
				.pinChatMessage({
					chat_id: owner,
					message_id: messageId,
					disable_notification: true,
				})
				.catch((error) => {
					// It is still a readable message, just not pinned — say so rather than
					// leave the owner wondering why the mode is not shown at the top.
					activeCtx?.ui.notify(
						`Sent the mode message but could not pin it: ${String(error)}`,
						"warning",
					);
				});
		} catch (error) {
			await forgetModePin();
			activeCtx?.ui.notify(
				`Could not announce the mode in Telegram: ${String(error)}`,
				"warning",
			);
		}
	};

	// Answer /start (incl. the Secretary "Manage Bot" deep link /start bizChat…) with
	// the privacy/compliance reminder — for ANY user, so whoever connects or opens
	// the bot sees the terms first. Returns true when it consumed the event.
	const handleStartCommand = async (event: TelegramEvent): Promise<boolean> => {
		if (event.kind !== "message") return false;
		const command = parseSlashCommand(event.message.text ?? "");
		if (command?.name !== "start") return false;
		const api = controlApi();
		if (!api) return false;
		await api
			.sendMessage({
				chat_id: event.chatId,
				message_thread_id: threadOf(event),
				text: COMPLIANCE_NOTICE,
				link_preview_options: { is_disabled: true },
			})
			.catch(() => {});
		// The owner pressing Start means their chat begins again — after deleting it,
		// that is the only way back in, and the chat has no mode message any more. Post
		// one showing whatever mode is actually running. (The old ids are dropped by the
		// update itself: deleting a message the owner already wiped simply fails.)
		if (event.fromId === ownerUserId && event.chatId === ownerUserId) {
			await updateModePin(activeTarget());
		}
		return true;
	};

	// Owner control pre-handler, wired ahead of both modes' routing. Returns true
	// when it consumes the event (so the mode router skips it).
	const handleControl = async (event: TelegramEvent): Promise<boolean> => {
		if (ownerUserId === null) return false;
		const api = controlApi();
		if (!api) return false;

		if (event.kind === "message") {
			// Only the owner's own DM with the bot (private chat id === user id).
			if (event.fromId !== ownerUserId || event.chatId !== ownerUserId) {
				return false;
			}
			const text = (event.message.text ?? "").trim();
			if (isSwitchCommand(text)) {
				await sendSwitchPanel(api, threadOf(event) ?? personalThread());
				return true;
			}
			// Stopping is a command, never a button: the Secretary connection is the
			// whole point of the bot, and a mistap while switching modes must not end it.
			if (isStopCommand(text)) {
				const stopped = activeTarget() === "stop";
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text: stopped
							? "The bot is already stopped. /switch starts a mode."
							: "⏹️ Stopping. /switch starts a mode again.",
					})
					.catch(() => {});
				if (!stopped) scheduleSwitch("stop");
				return true;
			}
			// /esc is the one command that must work in EVERY mode, always: it is the
			// keyboard's Escape, reachable from the phone. Personal and mixed route it
			// through the ConnectController (rich card); manager mode has no controller, and
			// used to have no /esc at all — the owner could watch a manager turn run away and
			// have no way to stop it without the terminal.
			if (!connect && /^\/(esc|cancel)(@\w+)?$/i.test(text)) {
				const outcome = await escapeSession();
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text:
							outcome === "aborted"
								? "⎋ Cancelled — stopped the current turn."
								: outcome === "idle"
									? "💤 Nothing to cancel — the agent is idle."
									: "⚠️ It did not stop. The session is still busy with nothing running — restart Pi to recover.",
					})
					.catch(() => {});
				return true;
			}
			// /status works in every mode. Manager mode has no ConnectController to render
			// the rich card, so the same report goes out as plain text.
			if (!connect && /^\/status(@\w+)?$/i.test(text)) {
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text: renderStatusText(statusInput()),
						link_preview_options: { is_disabled: true },
					})
					.catch(() => {});
				return true;
			}
			// /context, likewise: in manager mode it reports the rebuilt per-chat context,
			// which is the one place you can see the isolation actually holding.
			if (!connect && /^\/context(@\w+)?$/i.test(text)) {
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text: renderContextText(contextInput()),
						link_preview_options: { is_disabled: true },
					})
					.catch(() => {});
				return true;
			}
			// The command menu is one list for every mode, so it offers /compact and /clear
			// in manager mode too — where neither means anything: the manager REBUILDS the
			// model's context from the chat store on every turn (see pi.on("context")), so
			// there is no accumulated session history to compact or to clear. Answer them,
			// rather than let a menu entry go silently nowhere — a button that does nothing
			// is worse than one that is not there. (In mixed, `connect` is live and handles
			// both for real.)
			if (!connect && /^\/(compact|clear|new|reset)(@\w+)?$/i.test(text)) {
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text: "🗜 /compact and /clear apply to personal and mixed mode. In manager mode I build the context fresh for each conversation, so there is no history to compact or clear.",
					})
					.catch(() => {});
				return true;
			}
			// /help works in the owner DM in every mode. Personal mode renders its own
			// rich help (ConnectController), so only answer here when it is inactive
			// (manager / mixed) — a plain message whose raw URLs Telegram auto-links.
			if (!connect && /^\/help(@\w+)?$/i.test(text)) {
				await api
					.sendMessage({
						chat_id: ownerUserId,
						message_thread_id: threadOf(event) ?? personalThread(),
						text: MANAGER_HELP_TEXT,
						// No preview card — a help message should stay compact, and Telegram
						// would otherwise card the last URL (the mirror) over the main repo.
						link_preview_options: { is_disabled: true },
					})
					.catch(() => {});
				return true;
			}
			return false;
		}

		if (event.kind === "callback_query") {
			if (event.fromId !== ownerUserId) return false;
			const target = parseSwitchData(event.data);
			if (!target) return false;
			const already = activeTarget() === target;
			// Answer immediately so the button stops spinning.
			await api
				.answerCallbackQuery({
					callback_query_id: event.query.id,
					text: already
						? `Already ${switchLabel(target)}`
						: `Switching to ${switchLabel(target)}…`,
				})
				.catch(() => {});
			if (!already) {
				// Optimistically reflect the choice now; the real switch runs after this
				// update settles (see scheduleSwitch). The captured `api` keeps working
				// for the edit even once its client is torn down.
				const chatId = event.chatId;
				const messageId = event.query.message?.message_id;
				if (chatId !== undefined && messageId !== undefined) {
					await api
						.editMessageReplyMarkup({
							chat_id: chatId,
							message_id: messageId,
							reply_markup: buildSwitchKeyboard(target),
						})
						.catch(() => {});
				}
				scheduleSwitch(target);
			}
			return true;
		}

		return false;
	};

	// ─── Connection watchdog ─────────────────────────────────────────────────
	// A silent liveness probe on whichever client is polling; after too many
	// consecutive failures the active mode auto-disconnects. grammY reconnects on
	// its own between probes, so the watchdog just bounds the grace window.
	const probeConnection = async (): Promise<boolean> => {
		const api = (managerClient ?? client)?.api as unknown as
			| { getMe(signal?: AbortSignal): Promise<unknown> }
			| undefined;
		if (!api) return false;
		try {
			await api.getMe(AbortSignal.timeout(CONNECTION_PROBE_TIMEOUT_MS));
			return true;
		} catch {
			return false;
		}
	};

	const disarmWatchdog = (): void => {
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = null;
		}
	};

	// One probe cycle: a healthy result clears the streak; a failed one escalates it
	// and, once the streak hits maxRetries, auto-disconnects the active mode. Fully
	// silent except the final auto-disconnect notice (never a per-probe log).
	const runWatchdog = async (maxRetries: number): Promise<void> => {
		if (watchdogBusy || (!manager && !connect)) return;
		watchdogBusy = true;
		try {
			if (await probeConnection()) {
				connectionFailures = 0;
				return;
			}
			connectionFailures += 1;
			if (watchdogVerdict(connectionFailures, maxRetries) === "disconnect") {
				const ctx = activeCtx;
				disarmWatchdog();
				connectionFailures = 0;
				await stopAll();
				ctx?.ui.notify(
					"Telegram auto-disconnected: the bot connection was unreachable across health checks.",
					"warning",
				);
			}
		} finally {
			watchdogBusy = false;
		}
	};

	// Arm the watchdog for a freshly-started mode (resetting the streak). Disabled or
	// a non-positive interval leaves it unarmed.
	const armWatchdog = (settings: TelegramSettings): void => {
		disarmWatchdog();
		connectionFailures = 0;
		const { enabled, intervalMs, maxRetries } = settings.connectionCheck;
		if (!enabled || intervalMs <= 0) return;
		watchdogTimer = setInterval(() => {
			void runWatchdog(maxRetries);
		}, intervalMs);
	};
}

/**
 * On manager activation, scan stored chats and queue the ones the bot should
 * catch up on (see {@link selectCatchUpChats}), replying for the owner. The
 * business connection id (needed to send) comes from the stored connections; if
 * none is known yet, catch-up is skipped.
 */
async function catchUpOnActivation(
	manager: ManagerController,
	chatStore: ChatStore,
	businessStore: BusinessStore,
	managerSettings: {
		ownerReplyWindowMs: number;
		catchUpWindowMs: number;
		rememberMessages: number;
	},
): Promise<void> {
	const connections = await businessStore.all();
	const connection = connections.find((c) => c.isEnabled) ?? connections[0];
	if (!connection) return;
	const chatIds = await chatStore.listChatIds();
	const chats: { chatId: string; records: ChatMessageRecord[] }[] = [];
	for (const chatId of chatIds) {
		const records = await chatStore.getRecent(
			chatId,
			managerSettings.rememberMessages,
		);
		if (records.length > 0) chats.push({ chatId, records });
	}
	const selected = selectCatchUpChats(chats, Date.now(), {
		ownerReplyWindowMs: managerSettings.ownerReplyWindowMs,
		catchUpWindowMs: managerSettings.catchUpWindowMs,
	});
	const byId = new Map(chats.map((chat) => [chat.chatId, chat.records]));
	for (const chatId of selected) {
		const records = byId.get(chatId) ?? [];
		const contactName = lastInterlocutorName(records) ?? chatId;
		// Carry the interlocutor's userId (from the stored transcript) so facts are
		// stored/shown for the right contact even before a fresh live message arrives.
		const userId = lastInterlocutorUserId(records, connection.userId);
		manager.markReady(chatId, {
			connectionId: connection.id,
			contactName,
			userId,
		});
	}
	// Memory catch-up, for EVERY chat with a transcript — not only the ones being
	// answered. Consolidation candidates were only ever created by live traffic, so a
	// conversation that ended before this process started was never consolidated at
	// all; queueing them here is what makes memory survive a restart.
	for (const chat of chats) {
		const userId = lastInterlocutorUserId(chat.records, connection.userId);
		if (!userId) continue; // no contact to remember facts about
		const activityAt = chat.records[chat.records.length - 1]?.timestamp;
		if (activityAt === undefined) continue;
		await manager
			.seedConsolidation(
				chat.chatId,
				{
					connectionId: connection.id,
					contactName: lastInterlocutorName(chat.records) ?? chat.chatId,
					userId,
				},
				activityAt,
			)
			.catch(() => {});
	}
}
