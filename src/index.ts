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
import { join } from "node:path";
import type { InlineKeyboardMarkup, Message } from "@grammyjs/types";
import { COMMANDS, TELEGRAM_BOT_COMMANDS } from "./constants";
import { AbortRegistry } from "./core/abort";
import { createAttachmentTools, TELEGRAM_TOOL_NAMES } from "./core/attachments";
import { watchdogVerdict } from "./core/connection-watchdog";
import { ContextReset } from "./core/context-reset";
import { formatNowLine } from "./core/datetime";
import { expandHome, readInstructionFiles } from "./core/instructions";
import { createLifecycleController, pidIsAlive } from "./core/lifecycle";
import {
	classifyInputSource,
	shouldMirrorToTelegram,
} from "./core/prompt-origin";
import type { TurnSavedFile } from "./core/turns";
import {
	loadConnectInstructions,
	loadManagerInstructions,
	SYSTEM_INSTRUCTIONS_HEADER,
} from "./instructions/builtin";
import { ConnectController } from "./modes/connect/controller";
import { card, note } from "./modes/connect/format";
import {
	extractText,
	lastAssistantReply,
	lastAssistantThinking,
	type PromptContent,
} from "./modes/connect/messages";
import { selectCatchUpChats } from "./modes/manager/catchup";
import { toRebuiltMessages } from "./modes/manager/context-isolation";
import {
	ManagerController,
	type ManagerTurnLog,
} from "./modes/manager/controller";
import {
	buildManagerFeed,
	buildManagerNotice,
	type ManagerNoticeLevel,
	type ManagerToolCall,
} from "./modes/manager/debug-feed";
import {
	createManagerTools,
	type DecisionSink,
	type FactSink,
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
	tagTelegramPrompt,
} from "./modes/manager/mixed-context";
import {
	managerGuardActive,
	managerHoldsSession,
	mixedContextSource,
} from "./modes/manager/polarity";
import { formatManagerReplyHtmlChunks } from "./modes/manager/reply-format";
import { selectManagerSubMode } from "./modes/manager/submode-picker";
import { resolveTelegramPaths } from "./pi/agent-dir";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";
import { createToolMatcher, type ToolMatcher } from "./pi/tool-allow";
import { registerToolGuard } from "./pi/tool-guard";
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
import { migrateMemory } from "./storage/memory-migration";
import { createSentRegistry } from "./storage/sent-registry";
import type { ManagerSubMode } from "./storage/singleton-store";
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
	isSwitchCommand,
	type PanelMode,
	parseSwitchData,
	type SwitchTarget,
	switchLabel,
	switchPanelText,
} from "./telegram/switch-panel";
import type { TelegramEvent } from "./telegram/updates";
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
		reply_markup?: InlineKeyboardMarkup;
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
	editMessageText(payload: {
		chat_id: number;
		message_id: number;
		text: string;
	}): Promise<unknown>;
	pinChatMessage(payload: {
		chat_id: number;
		message_id: number;
		disable_notification?: boolean;
	}): Promise<unknown>;
}

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
/** How long a single connection-watchdog probe (getMe) may take before it counts as failed. */
const CONNECTION_PROBE_TIMEOUT_MS = 15_000;
const TYPING_REFRESH_MS = 4_000;
const DRAFT_THROTTLE_MS = 700;
const MANAGER_TICK_MS = 5_000;
const STATUS_KEY = "telegram";
const MANAGER_BANNER_KEY = "telegram-manager-banner";

// Every tool the manager may use in the telegram-sandbox: the reply/memory tools
// plus the consolidation interrogation probes.
const MANAGER_TOOLS = [...MANAGER_TOOL_NAMES, ...INTERROGATION_TOOL_NAMES];

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
		connect: TELEGRAM_TOOL_NAMES,
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
	});

	// Rebuild the LLM context per mode: the manager replaces it with the active
	// chat's isolated history (mode 2); mode 1 applies the /clear boundary. No
	// mode / no boundary → leave the context untouched.
	pi.on("context", async (event) => {
		const source = mixedContextSource(manager !== null, mixedActive, polarity);
		// Coding polarity (mixed): the owner's real session messages, with the
		// manager's Telegram turns filtered out so they never pollute the thread.
		if (source === "coding-filtered") {
			return { messages: stripTelegramTurns(event.messages) } as never;
		}
		// Manager / mixed-telegram: replace context with the active chat's isolated
		// history so the model sees only that one conversation.
		if (source === "manager-chat" && manager) {
			const isolated = await manager.buildContextForActive();
			if (!isolated) return {};
			return {
				messages: toRebuiltMessages(isolated, Date.now()),
			} as never;
		}
		const filtered = contextReset.apply(event.messages);
		// Mode 1: prepend the connect system instructions so the agent knows it is
		// bridged to Telegram (files saved to disk, telegram_attach to send back).
		// The prepended block is kept byte-identical across calls (constant content +
		// a stable timestamp) so the provider's prompt cache holds over the whole
		// shared terminal session; the volatile date/time goes in a SEPARATE trailing
		// message, outside the cached prefix, so a fresh clock never invalidates the
		// entire context (which made a big terminal session re-prefill every turn).
		if (connect && connectSystemBlock) {
			return {
				messages: [
					{
						role: "user",
						content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${connectSystemBlock}`,
						timestamp: 0,
					},
					...(filtered ?? event.messages),
					{
						role: "user",
						content: formatNowLine(Date.now(), connectTimezone),
						timestamp: Date.now(),
					},
				],
			} as never;
		}
		return filtered ? { messages: filtered } : {};
	});

	// Live connect-mode runtime (null when inactive).
	let connect: ConnectController | null = null;
	let client: TelegramClient | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let busy = false;
	// Mirror agent tool calls to Telegram as collapsible blocks (mode 1).
	let toolActivityEnabled = false;
	// Stream the assistant reply as an animated draft while it generates.
	let draftPreviewsEnabled = false;
	let draftText = "";
	let lastDraftAt = 0;
	// Mode-1 system instructions (bundled connect.md + user override), injected at
	// the head of the context while connect is active; null when inactive.
	let connectSystemBlock: string | null = null;
	// Timezone for the mode-1 `[Now: …]` line (from settings; system zone if unset).
	let connectTimezone: string | undefined;

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
	// the owner; `activeSubMode` tracks the running manager sub-mode so the panel
	// can highlight the current mode.
	let activeCtx: ExtensionCommandContext | null = null;
	let ownerUserId: number | null = null;
	let activeSubMode: ManagerSubMode | null = null;

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
	// The pinned "current mode" indicator in the owner's DM: the message id we pin
	// once and then edit in place on every mode change (so switches never spam new
	// pins), plus the mode it currently shows (to skip redundant edits).
	let modePinMessageId: number | null = null;
	let modePinTarget: PanelMode | null = null;

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
			managerUi.setWidget(
				MANAGER_BANNER_KEY,
				managerBannerLines(manager.status()),
			);
		} catch {
			// A captured UI handle may go stale across a session reload; the banner
			// is cosmetic, so a failed refresh must never break the manager.
		}
	};

	// Mixed mode's only persistent TUI chrome: a one-line status showing the mode,
	// sub-mode, and which polarity the shared brain is serving right now.
	const updateMixedFooter = (): void => {
		if (!mixedActive) return;
		const where = polarity === "telegram" ? "in Telegram" : "coding";
		activeCtx?.ui.setStatus(
			STATUS_KEY,
			`mixed · ${activeSubMode ?? "observer"} · ${where}`,
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
			void manager?.onTick().then(updateManagerBanner);
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

	const sendFollowUp = async (content: PromptContent): Promise<void> => {
		await pi.sendUserMessage(content, { deliverAs: "followUp" });
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
	for (const tool of [
		...createManagerTools(managerDecisionSink, managerFactSink),
		...createInterrogationTools(managerProbeSink),
	]) {
		pi.registerTool(tool);
	}

	const stopConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		stopTyping();
		disarmWatchdog();
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		await client?.stop().catch(() => {});
		client = null;
		connect = null;
		connectSystemBlock = null;
		connectTimezone = undefined;
		toolActivityEnabled = false;
		draftPreviewsEnabled = false;
		contextReset.forget();
		await lifecycle.deactivate("connect");
		visibility.setActive("connect", false);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const stopManager = async (): Promise<void> => {
		disarmWatchdog();
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
		activeSubMode = null;
		deliverManagerFeed = null;
		mirrorManagerNotice = null;
		visibility.setActive("manager", false);
		visibility.setExclusive("manager", null);
		managerMatcher = null;
		managerUi?.setWidget(MANAGER_BANNER_KEY, undefined);
		managerUi = null;
		// Tear down mixed-mode state (a no-op for the standalone manager). Deactivate
		// the lifecycle record for whichever mode was actually running.
		const wasMixed = mixedActive;
		if (wasMixed) {
			cancelMixedReturnTimer();
			mixedActive = false;
			polarity = "coding";
			activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		}
		await lifecycle.deactivate(wasMixed ? "mixed" : "manager");
	};

	// Route business updates to the manager controller. Owner control commands
	// (`/switch`, panel button presses) are intercepted first, in both modes.
	const routeManagerEvent = async (event: TelegramEvent): Promise<void> => {
		if (await handleControl(event)) return;
		if (!manager) return;
		if (event.kind === "business_connection") {
			await manager.onBusinessConnection({
				connectionId: event.connectionId,
				connection: event.connection,
				isEnabled: event.isEnabled,
			});
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
		managerTurnTools = [];
		// Arm the interrupt for the running turn in BOTH modes, so a priority owner
		// action can abort it immediately: /esc in mode 1, or /switch in either mode
		// (which must not wait for a long consolidation/reply to finish).
		abort.set(() => ctx.abort());
		startTyping();
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
		if (!managerHoldsSession(mixedActive, polarity)) return;
		if (manager?.turnDecided()) ctx.abort();
	});
	pi.on("agent_end", async (event) => {
		busy = false;
		// Disarm the interrupt for the finished turn (both modes); the next turn
		// re-arms it in agent_start.
		abort.clear();
		stopTyping();
		connect?.endDraft();
		await connect?.onAgentEnd(event.messages);
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
			if (log && deliverManagerFeed) {
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
		if (!connect || !toolActivityEnabled) return;
		await connect
			.sendToolActivity({ toolName: event.toolName, args: event.args })
			.catch(() => {});
	});

	// Live streaming preview: open a draft when the assistant message starts and
	// animate it (throttled) as tokens arrive. The draft is ephemeral — it never
	// edits or deletes a real message; the final reply is a fresh send in
	// onAgentEnd, so the full history is preserved.
	pi.on("message_start", (event) => {
		if (!connect || !draftPreviewsEnabled) return;
		if ((event.message as { role?: string })?.role !== "assistant") return;
		connect.beginDraft();
		draftText = "";
		lastDraftAt = 0;
	});
	pi.on("message_update", async (event) => {
		if (!connect || !draftPreviewsEnabled) return;
		const text = extractText(
			(event.message as { content?: unknown }).content as never,
		);
		if (!text || text === draftText) return;
		draftText = text;
		const now = Date.now();
		if (now - lastDraftAt < DRAFT_THROTTLE_MS) return;
		lastDraftAt = now;
		await connect.streamDraft(text);
	});

	// Mirror prompts typed at the Pi terminal into Telegram for a unified history.
	// We key off Pi's own provenance (InputEvent.source) — our Telegram injections
	// arrive as "extension" and are not mirrored, so there is no echo loop.
	pi.on("input", async (event) => {
		const origin = classifyInputSource(event.source);
		if (connect && shouldMirrorToTelegram(origin)) {
			await connect.mirrorTerminalInput(event.text).catch(() => {});
		}
		// Mixed mode: a prompt the owner typed at the terminal is the priority
		// signal. Take the shared brain back for coding at once — cancel the return
		// timer and, if the manager was mid-turn in the Telegram polarity, abort it
		// so the owner never waits on a moderation reply. Our own Telegram injections
		// arrive as "external" and are ignored here.
		if (mixedActive && origin === "terminal") {
			cancelMixedReturnTimer();
			const wasTelegram = polarity === "telegram";
			setPolarity("coding");
			if (wasTelegram) await abort.abort();
		}
		return { action: "continue" };
	});

	// Let the chat know when context compaction runs, so a mid-turn pause is
	// explained rather than looking like a hang. There is no dedicated
	// "compaction failed" event; a genuine failure surfaces through the normal
	// agent error path.
	pi.on("session_before_compact", async () => {
		await connect
			?.sendToChat(
				card("🗜", "Compacting context", [
					note("Freeing up space — one moment…"),
				]),
			)
			.catch(() => {});
	});
	pi.on("session_compact", async () => {
		await connect
			?.sendToChat(card("✅", "Context compacted", [note("Continuing.")]))
			.catch(() => {});
	});
	pi.on("session_shutdown", async () => {
		if (connect) {
			await connect
				.sendToChat(
					card("🔌", "Pi session closed", [
						note("The bridge is no longer active."),
					]),
				)
				.catch(() => {});
		}
	});

	// Both mode launchers load settings, surface any warnings, and need the bot
	// token; this centralises that and bails (returning null) with a clear message
	// when the token is unset.
	const loadSettingsAndToken = async (
		ctx: ExtensionCommandContext,
	): Promise<{ settings: TelegramSettings; token: string } | null> => {
		const { settings, warnings } = await loadSettings(fs, paths.settingsPath);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
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

	// Mode-1 launcher, extracted from the command handler so `switchMode` can start
	// it from a Telegram button press too. Captures `activeCtx`/`ownerUserId` for the
	// control panel.
	const startConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		activeCtx = ctx;
		if (connect) {
			ctx.ui.notify("Telegram connect is already active.", "warning");
			return;
		}
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
		connectTimezone = settings.timezone;

		client = new TelegramClient({
			token,
			onEvent: async (event) => {
				if (await handleControl(event)) return;
				await connect?.onEvent(event);
			},
			onError: (error) =>
				ctx.ui.notify(`Telegram error: ${String(error)}`, "error"),
		});
		// Warn once (not per-message) when native rich rendering isn't reaching
		// Telegram and we degraded to plain text — so a tester can tell a real
		// rich reply from a fallback one.
		let richFallbackWarned = false;
		const outbound = new OutboundSender(client.api as unknown as OutboundApi, {
			onRichFallback: (error) => {
				if (richFallbackWarned) return;
				richFallbackWarned = true;
				ctx.ui.notify(
					`Native rich rendering unavailable — sending plain text instead (${String(error)}).`,
					"warning",
				);
			},
		});
		const media = new MediaDownloader({
			api: client.api as unknown as FileApi,
			fetchBytes: fetchBytesFromUrl,
			fileBaseUrl: fileBaseUrl(token),
			maxBytes: settings.files.maxBytes,
		});
		const loadImages = (message: Message) =>
			loadInlineImages(media, message, settings.files.maxBytes);
		// Where inbound non-image files land: the configured dir, else the
		// directory Pi runs in.
		const downloadDir = settings.files.downloadDir
			? expandHome(settings.files.downloadDir)
			: process.cwd();
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
		const uploadFile = async (input: {
			path?: string;
			url?: string;
			caption?: string;
		}) => {
			if (input.path && !(await fs.exists(input.path))) {
				throw new Error(`file not found: ${input.path}`);
			}
			await client?.sendDocument({ chatId: allowedUserId, ...input });
		};
		connect = new ConnectController({
			allowedUserId,
			maxBytes: settings.files.maxBytes,
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
			onAbort: async () => {
				// Interrupt the running turn via the handler armed on agent_start.
				const stopped = await abort.abort();
				await connect?.sendToChat(
					stopped
						? card("⎋", "Cancelled", [note("Stopped the current turn.")])
						: card("💤", "Nothing to cancel", [note("The agent is idle.")]),
				);
			},
			onContact: async (user) => {
				await contactStore.upsertProfile(
					extractProfileFromUser(user),
					Date.now(),
				);
			},
			outbound,
			abort,
		});
		toolActivityEnabled = settings.assistant.toolActivity;
		draftPreviewsEnabled = settings.assistant.draftPreviews;
		void client.start();
		// Publish the tappable command menu (no manual setup needed by the user).
		void client.api
			.setMyCommands({ commands: TELEGRAM_BOT_COMMANDS })
			.catch(() => {});
		heartbeat = setInterval(() => {
			void lifecycle.heartbeat();
		}, HEARTBEAT_INTERVAL_MS);
		armWatchdog(settings);
		visibility.setActive("connect", true);
		ctx.ui.setStatus(STATUS_KEY, `Telegram: connected (chat ${allowedUserId})`);
		// Route through the Markdown pipeline (sendToChat), not notify(): notify
		// HTML-escapes its string, so any `*`/`_` markup would show up literally.
		await connect
			.sendToChat(
				card("🔗", "Connected", [note("Bound to the Pi terminal session.")]),
			)
			.catch(() => {});
		ctx.ui.notify("Telegram connect: active.");
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

	// Shared launcher for both manager sub-modes, and for mixed mode (`mixed:
	// true`), which runs the same manager runtime alongside the owner's coding
	// thread in one session. The sub-mode comes from the command's picker, not from
	// settings.
	const startManager = async (
		ctx: ExtensionCommandContext,
		subMode: ManagerSubMode,
		options: { mixed?: boolean } = {},
	): Promise<void> => {
		const mixed = options.mixed === true;
		activeCtx = ctx;
		if (manager || connect) {
			ctx.ui.notify("A Telegram mode is already active.", "warning");
			return;
		}
		const loaded = await loadSettingsAndToken(ctx);
		if (!loaded) return;
		const { settings, token } = loaded;
		ownerUserId = settings.allowedUserId ?? null;
		activeSubMode = subMode;
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
			subMode,
		});
		if (!activation.ok) {
			mixedActive = false;
			ctx.ui.notify(
				`Cannot start ${mixed ? "mixed" : "manager"}: ${activation.reason}`,
				"error",
			);
			return;
		}

		// Assemble the manager's system instructions: the bundled defaults for this
		// sub-mode plus any user override files (global + manager + sub-mode).
		const overrideFiles = [
			...settings.instructionFiles,
			...settings.manager.instructionFiles,
			...(subMode === "takeover"
				? [settings.manager.takeover.instructionFile]
				: [
						settings.manager.observer.interlocutorInstructionFile,
						settings.manager.observer.ownerInstructionFile,
					]),
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
			subMode,
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
		managerMatcher = createToolMatcher(
			MANAGER_TOOLS,
			settings.manager.allowedTools,
			(warning) => ctx.ui.notify(warning, "warning"),
		);

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
		const businessStore = createBusinessStore(fs, paths.businessPath);
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
			subMode,
			instructions,
			labeler: settings.manager.labeler,
			rememberMessages: settings.manager.rememberMessages,
			continueWindowMs: settings.manager.continueWindowMs,
			ownerReplyWindowMs: settings.manager.ownerReplyWindowMs,
			factsLimit: settings.manager.factsLimit,
			factConsolidationQuietMs: settings.manager.factConsolidationQuietMs,
			verifyLimit: settings.manager.verifyLimit,
			liveFreshnessMs: settings.manager.liveFreshnessMs,
			reopenAfterMs: settings.manager.reopenAfterMs,
			reviseThreshold: settings.manager.reviseThreshold,
			ownerName: settings.manager.ownerName,
			strictReplyGuard: settings.manager.strictReplyGuard,
			mentionWords: effectiveMentionWords,
			timezone: settings.timezone,
			maxBytes: settings.files.maxBytes,
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
				pi.sendUserMessage(content, { deliverAs: "followUp" });
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
		// The bot account is idle in mode 2, so with debugFeed on it doubles as an
		// observability channel: each turn (and runtime warnings/errors) is mirrored
		// to the owner's private chat with the bot — sent AS the bot (no business
		// connection), so it never leaks into the managed conversation.
		if (settings.manager.debugFeed) {
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
					await managerOutbound.notify({ chatId }, html);
				} catch (error) {
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
						subMode,
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
		// Publish the tappable command menu (so /switch is reachable in mode 2 too).
		void managerClient.api
			.setMyCommands({ commands: TELEGRAM_BOT_COMMANDS })
			.catch(() => {});
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
			void manager?.onTick().then(updateManagerBanner);
		}, MANAGER_TICK_MS);
		managerHeartbeat = setInterval(() => {
			void lifecycle.heartbeat();
		}, HEARTBEAT_INTERVAL_MS);
		armWatchdog(settings);
		if (mixed) {
			// Mixed shows the footer indicator in the TUI AND a pinned indicator in the
			// bot DM (so the bot chat reflects it too); arm the idle timer so an idle
			// owner hands the brain to Telegram on its own.
			updateMixedFooter();
			armMixedReturnTimer();
			ctx.ui.notify(`Telegram mixed: active (${subMode}).`);
			await updateModePin("mixed");
		} else {
			ctx.ui.notify(`Telegram manager: active (${subMode}).`);
			await updateModePin(subMode);
		}
	};

	// Personal (mode 1): bind this terminal session to a single Telegram DM.
	pi.registerCommand(COMMANDS.personal, {
		description:
			"Bind this terminal session to a Telegram chat (personal mode).",
		handler: (_args, ctx) => startConnect(ctx),
	});
	// Business manager: pick a sub-mode, then run the manager.
	pi.registerCommand(COMMANDS.manager, {
		description:
			"Start the Telegram business manager (pick observer or takeover).",
		handler: async (_args, ctx) => {
			const subMode = await selectManagerSubMode(ctx.ui);
			if (!subMode) return;
			await startManager(ctx, subMode);
		},
	});
	// Mixed: coding + Telegram moderation share one session (pick a sub-mode).
	pi.registerCommand(COMMANDS.mixed, {
		description:
			"Run coding and Telegram moderation together (pick observer or takeover).",
		handler: async (_args, ctx) => {
			const subMode = await selectManagerSubMode(ctx.ui, "Mixed mode sub-mode");
			if (!subMode) return;
			await startManager(ctx, subMode, { mixed: true });
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
	// Mixed reports as "mixed" (not its sub-mode) so it never collides with the
	// observer/takeover buttons — a tap while in mixed then always switches away.
	const activeTarget = (): PanelMode => {
		if (manager) return mixedActive ? "mixed" : (activeSubMode ?? "observer");
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
		if (target === "observer" || target === "takeover") {
			await startManager(ctx, target);
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

	// Send a fresh mode-switcher panel to the owner's DM.
	const sendSwitchPanel = async (api: ControlApi): Promise<void> => {
		if (ownerUserId === null) return;
		const active = activeTarget();
		await api
			.sendMessage({
				chat_id: ownerUserId,
				text: switchPanelText(active),
				reply_markup: buildSwitchKeyboard(active),
			})
			.catch(() => {});
	};

	// Keep a pinned message at the top of the owner's DM showing the active mode, so
	// the current mode is always visible without running a command. Pinned once, then
	// edited in place on every change (no new pins per switch); "stop" shows the bot
	// is off. Best-effort — never blocks a mode start/stop.
	const modePinText = (target: PanelMode): string => {
		if (target === "stop")
			return "📌 Bot mode: ⏹️ Stopped\nUse /switch to start a mode.";
		if (target === "mixed")
			return `📌 Bot mode: ${switchLabel("mixed")} (${activeSubMode ?? "observer"})\nMixed runs from the terminal; /switch to switch away.`;
		return `📌 Bot mode: ${switchLabel(target)}\nUse /switch to change.`;
	};

	const updateModePin = async (target: PanelMode): Promise<void> => {
		if (ownerUserId === null || modePinTarget === target) return;
		const api = controlApi();
		if (!api) return;
		const text = modePinText(target);
		try {
			if (modePinMessageId !== null) {
				await api.editMessageText({
					chat_id: ownerUserId,
					message_id: modePinMessageId,
					text,
				});
			} else {
				const sent = await api.sendMessage({ chat_id: ownerUserId, text });
				modePinMessageId = sent.message_id;
				await api
					.pinChatMessage({
						chat_id: ownerUserId,
						message_id: sent.message_id,
						disable_notification: true,
					})
					.catch(() => {});
			}
			modePinTarget = target;
		} catch {
			// The pinned message was likely deleted — forget it so the next update
			// re-creates and re-pins from scratch.
			modePinMessageId = null;
			modePinTarget = null;
		}
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
			if (!isSwitchCommand(event.message.text ?? "")) return false;
			await sendSwitchPanel(api);
			return true;
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
						: target === "stop"
							? "Stopping…"
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

	pi.registerCommand(COMMANDS.switch, {
		description: "Open the Telegram mode switcher in the owner's bot DM.",
		handler: async (_args, ctx) => {
			activeCtx = ctx;
			const api = controlApi();
			if (!api || ownerUserId === null) {
				ctx.ui.notify(
					"Start a Telegram mode first (the bot must be running to open the switcher).",
					"warning",
				);
				return;
			}
			await sendSwitchPanel(api);
			ctx.ui.notify("Telegram switcher: sent to your bot DM.");
		},
	});

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

/** The display name of the most recent interlocutor message, if any. */
function lastInterlocutorName(
	records: readonly ChatMessageRecord[],
): string | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		if (records[i].author === "interlocutor") return records[i].senderName;
	}
	return undefined;
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
		const contactName = lastInterlocutorName(byId.get(chatId) ?? []) ?? chatId;
		manager.markReady(chatId, { connectionId: connection.id, contactName });
	}
}
