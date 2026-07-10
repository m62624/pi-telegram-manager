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
import { COMMANDS, TELEGRAM_BOT_COMMANDS } from "./constants";
import { AbortRegistry } from "./core/abort";
import { createAttachmentTools, TELEGRAM_TOOL_NAMES } from "./core/attachments";
import { ContextReset } from "./core/context-reset";
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
import { extractText, type PromptContent } from "./modes/connect/messages";
import { selectCatchUpChats } from "./modes/manager/catchup";
import { toRebuiltMessages } from "./modes/manager/context-isolation";
import { ManagerController } from "./modes/manager/controller";
import {
	createManagerTools,
	type DecisionSink,
	MANAGER_TOOL_NAMES,
} from "./modes/manager/decision";
import { resolveTelegramPaths } from "./pi/agent-dir";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";
import { createToolMatcher, type ToolMatcher } from "./pi/tool-allow";
import { registerToolGuard } from "./pi/tool-guard";
import {
	createToolVisibility,
	registerToolVisibility,
} from "./pi/tool-visibility";
import { loadSettings } from "./settings/manager";
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
import { createContactStore } from "./storage/contact-store";
import { createNodeFs } from "./storage/fs";
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
	MediaDownloader,
	toBase64,
} from "./telegram/media";
import { type OutboundApi, OutboundSender } from "./telegram/outbound";
import { extractProfileFromUser } from "./telegram/profile";
import type { TelegramEvent } from "./telegram/updates";
import { managerBannerLines } from "./ui/manager-banner";

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const TYPING_REFRESH_MS = 4_000;
const DRAFT_THROTTLE_MS = 700;
const MANAGER_TICK_MS = 5_000;
const STATUS_KEY = "telegram";
const MANAGER_BANNER_KEY = "telegram-manager-banner";

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
		manager: MANAGER_TOOL_NAMES,
	});
	registerToolVisibility(pi, visibility);
	// Runtime backstop for the telegram-sandbox: block any tool the manager's
	// allowlist does not permit, even if it slipped past the visibility gate.
	registerToolGuard(pi, {
		isActive: () => manager !== null,
		matcher: () => managerMatcher,
	});

	// Rebuild the LLM context per mode: the manager replaces it with the active
	// chat's isolated history (mode 2); mode 1 applies the /clear boundary. No
	// mode / no boundary → leave the context untouched.
	pi.on("context", async (event) => {
		if (manager) {
			const isolated = await manager.buildContextForActive();
			if (!isolated) return {};
			return {
				messages: toRebuiltMessages(isolated, Date.now()),
			} as never;
		}
		const filtered = contextReset.apply(event.messages);
		// Mode 1: prepend the connect system instructions so the agent knows it is
		// bridged to Telegram (files saved to disk, telegram_attach to send back).
		if (connect && connectSystemBlock) {
			return {
				messages: [
					{
						role: "user",
						content: `${SYSTEM_INSTRUCTIONS_HEADER}\n\n${connectSystemBlock}`,
						timestamp: Date.now(),
					},
					...(filtered ?? event.messages),
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

	// Live manager-mode runtime (null when inactive).
	let manager: ManagerController | null = null;
	// The active telegram-sandbox allowlist; null while the manager is inactive.
	let managerMatcher: ToolMatcher | null = null;
	let managerClient: TelegramClient | null = null;
	let managerTick: ReturnType<typeof setInterval> | null = null;
	let managerHeartbeat: ReturnType<typeof setInterval> | null = null;
	let managerUi: {
		setWidget: ExtensionCommandContext["ui"]["setWidget"];
	} | null = null;

	const updateManagerBanner = (): void => {
		if (!manager || !managerUi) return;
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

	// Registered once at load; the visibility gate hides them until a mode is
	// active, and they route through whichever ConnectController is live.
	for (const tool of createAttachmentTools({
		async sendMessage(text) {
			await connect?.sendToChat(text);
		},
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
	for (const tool of createManagerTools(managerDecisionSink)) {
		pi.registerTool(tool);
	}

	const stopConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		stopTyping();
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		await client?.stop().catch(() => {});
		client = null;
		connect = null;
		connectSystemBlock = null;
		toolActivityEnabled = false;
		draftPreviewsEnabled = false;
		contextReset.forget();
		await lifecycle.deactivate("connect");
		visibility.setActive("connect", false);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const stopManager = async (): Promise<void> => {
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
		visibility.setActive("manager", false);
		visibility.setExclusive("manager", null);
		managerMatcher = null;
		managerUi?.setWidget(MANAGER_BANNER_KEY, undefined);
		managerUi = null;
		await lifecycle.deactivate("manager");
	};

	// Route business updates to the manager controller.
	const routeManagerEvent = async (event: TelegramEvent): Promise<void> => {
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
		connect?.onAgentStart(() => ctx.abort());
		startTyping();
	});
	pi.on("agent_end", async (event) => {
		busy = false;
		stopTyping();
		connect?.endDraft();
		await connect?.onAgentEnd(event.messages);
		if (manager) {
			await manager.onAgentEnd();
			updateManagerBanner();
		}
	});
	pi.on("tool_execution_start", async (event) => {
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
		if (connect && shouldMirrorToTelegram(classifyInputSource(event.source))) {
			await connect.mirrorTerminalInput(event.text).catch(() => {});
		}
		return { action: "continue" };
	});

	// Let the chat know when context compaction runs, so a mid-turn pause is
	// explained rather than looking like a hang. There is no dedicated
	// "compaction failed" event; a genuine failure surfaces through the normal
	// agent error path.
	pi.on("session_before_compact", async () => {
		await connect
			?.sendToChat("🗜 Compacting context to free up space — one moment…")
			.catch(() => {});
	});
	pi.on("session_compact", async () => {
		await connect
			?.sendToChat("✅ Context compacted — continuing.")
			.catch(() => {});
	});
	pi.on("session_shutdown", async () => {
		if (connect) {
			await connect
				.sendToChat("Pi session closed. The bridge is no longer active.")
				.catch(() => {});
		}
	});

	pi.registerCommand(COMMANDS.connect, {
		description: "Bind this terminal session to a Telegram chat (mode 1).",
		handler: async (_args, ctx) => {
			if (connect) {
				ctx.ui.notify("Telegram connect is already active.", "warning");
				return;
			}
			const { settings, warnings } = await loadSettings(fs, paths.settingsPath);
			for (const warning of warnings) ctx.ui.notify(warning, "warning");
			const token = resolveSecret(settings.botToken);
			if (!token) {
				ctx.ui.notify(
					'Set botToken in settings.json (or "env:TELEGRAM_BOT_TOKEN" to read it from the environment).',
					"error",
				);
				return;
			}
			if (!settings.allowedUserId) {
				ctx.ui.notify("Set allowedUserId in settings.json first.", "error");
				return;
			}
			const allowedUserId = settings.allowedUserId;
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

			client = new TelegramClient({
				token,
				onEvent: async (event) => {
					await connect?.onEvent(event);
				},
				onError: (error) =>
					ctx.ui.notify(`Telegram error: ${String(error)}`, "error"),
			});
			// Warn once (not per-message) when native rich rendering isn't reaching
			// Telegram and we degraded to plain text — so a tester can tell a real
			// rich reply from a fallback one.
			let richFallbackWarned = false;
			const outbound = new OutboundSender(
				client.api as unknown as OutboundApi,
				{
					onRichFallback: (error) => {
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
				api: client.api as unknown as FileApi,
				fetchBytes: fetchBytesFromUrl,
				fileBaseUrl: fileBaseUrl(token),
				maxBytes: settings.files.maxBytes,
			});
			// Download a message's image attachments so the model actually sees the
			// picture, not just the "[attachments: photo]" text header. Telegram
			// photos have no mime type (always JPEG); over-cap/unavailable files are
			// skipped per-file so a bad attachment never sinks the whole turn.
			const loadImages = async (
				message: Parameters<typeof describeAttachments>[0],
			) => {
				const refs = describeAttachments(
					message,
					settings.files.maxBytes,
				).filter(isImage);
				const images: { data: string; mimeType: string }[] = [];
				for (const ref of refs) {
					try {
						const file = await media.download(ref);
						images.push({
							data: toBase64(file.bytes),
							mimeType: ref.mimeType ?? "image/jpeg",
						});
					} catch {
						// too large / unavailable — the text header still mentions it.
					}
				}
				return images;
			};
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
				const refs = describeAttachments(
					message,
					settings.files.maxBytes,
				).filter((ref) => !isImage(ref));
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
							"⏳ Busy right now — send /clear again once I finish.",
						);
						return;
					}
					contextReset.clear(Date.now());
					await connect?.sendToChat(
						"🧹 History cleared — starting fresh. (Shared session: the terminal sees the cleared context too.)",
					);
				},
				onAbort: async () => {
					// Interrupt the running turn via the handler armed on agent_start.
					const stopped = await abort.abort();
					await connect?.sendToChat(
						stopped
							? "⎋ Cancelled the current turn."
							: "Nothing to cancel — the agent is idle.",
					);
				},
				// Discovery only: list every registered Pi command (incl. other
				// extensions'). The SDK exposes no way to execute another
				// extension's command remotely, so these are shown as terminal-run.
				listCommands: () =>
					pi.getCommands().map((command) => ({
						name: command.name,
						description: command.description,
					})),
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
			visibility.setActive("connect", true);
			ctx.ui.setStatus(
				STATUS_KEY,
				`Telegram: connected (chat ${allowedUserId})`,
			);
			await outbound
				.notify(
					{ chatId: allowedUserId },
					"Connected to the Pi terminal session.",
				)
				.catch(() => {});
			ctx.ui.notify("Telegram connect: active.");
		},
	});

	pi.registerCommand(COMMANDS.disconnect, {
		description: "Disconnect the terminal-continuation bridge (mode 1).",
		handler: async (_args, ctx) => {
			if (!connect) {
				ctx.ui.notify("Telegram connect is not active.", "warning");
				return;
			}
			// Tell the chat before we tear down the poller/sender.
			await connect
				.sendToChat("🔌 Disconnected from the Pi terminal session.")
				.catch(() => {});
			await stopConnect(ctx);
			ctx.ui.notify("Telegram connect: stopped.");
		},
	});

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

	// Shared launcher for both manager sub-modes; the sub-mode comes from the
	// command the user ran (observer or takeover), not from settings.
	const startManager = async (
		ctx: ExtensionCommandContext,
		subMode: ManagerSubMode,
	): Promise<void> => {
		if (manager || connect) {
			ctx.ui.notify("A Telegram mode is already active.", "warning");
			return;
		}
		const { settings, warnings } = await loadSettings(fs, paths.settingsPath);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		const token = resolveSecret(settings.botToken);
		if (!token) {
			ctx.ui.notify(
				'Set botToken in settings.json (or "env:TELEGRAM_BOT_TOKEN").',
				"error",
			);
			return;
		}

		const activation = await lifecycle.activate({
			mode: "manager",
			workdir: paths.managerWorkspaceDir,
			subMode,
		});
		if (!activation.ok) {
			ctx.ui.notify(`Cannot start manager: ${activation.reason}`, "error");
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
		const instructions = await loadManagerInstructions({
			fs,
			subMode,
			labeler: settings.manager.labeler,
			overrideText: override.text,
			firstMessageOverride,
		});

		// The telegram-sandbox allowlist: only the manager's messaging tools, plus
		// any user-configured regex names. Everything else (read/write/bash,
		// ask_user, foreign extensions) is hidden by visibility and blocked by the
		// runtime guard.
		managerMatcher = createToolMatcher(
			MANAGER_TOOL_NAMES,
			settings.manager.allowedTools,
			(warning) => ctx.ui.notify(warning, "warning"),
		);

		// NOTE: we deliberately do NOT ctx.switchSession() here. switchSession is
		// terminal — it staleness-poisons the captured `ctx` and the module-level
		// `pi`, but the manager needs `pi.sendUserMessage` on every turn from the
		// polling loop. So the manager runs in the current session; per-chat
		// isolation is guaranteed by pi.on("context") rebuilding messages, and the
		// banner tells the user this session is now the manager.

		const chatStore = createChatStore(fs, paths);
		const businessStore = createBusinessStore(fs, paths.businessPath);
		managerClient = new TelegramClient({
			token,
			onEvent: routeManagerEvent,
			onError: (error) =>
				ctx.ui.notify(`Telegram error: ${String(error)}`, "error"),
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
		const loadManagerImages = async (
			message: Parameters<typeof describeAttachments>[0],
		) => {
			const refs = describeAttachments(message, settings.files.maxBytes).filter(
				isImage,
			);
			const images: { data: string; mimeType: string }[] = [];
			for (const ref of refs) {
				try {
					const file = await managerMedia.download(ref);
					images.push({
						data: toBase64(file.bytes),
						mimeType: ref.mimeType ?? "image/jpeg",
					});
				} catch {
					// too large / unavailable — the "[image]" marker still notes it.
				}
			}
			return images;
		};
		const api = managerClient.api as unknown as {
			sendMessage(args: {
				business_connection_id: string;
				chat_id: number;
				text: string;
			}): Promise<{ message_id: number }>;
			sendChatAction(args: {
				business_connection_id: string;
				chat_id: number;
				action: "typing";
			}): Promise<unknown>;
		};
		manager = new ManagerController({
			subMode,
			instructions,
			labeler: settings.manager.labeler,
			rememberMessages: settings.manager.rememberMessages,
			continueWindowMs: settings.manager.continueWindowMs,
			ownerReplyWindowMs: settings.manager.ownerReplyWindowMs,
			maxBytes: settings.files.maxBytes,
			media: settings.manager.media,
			loadImages: loadManagerImages,
			clock: { now: () => Date.now() },
			chatStore,
			contactStore,
			sentRegistry: createSentRegistry(fs, paths.sentRegistryPath),
			businessStore,
			isIdle: () => !busy,
			triggerAgent: async (prompt) => {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			},
			sendReply: async ({ connectionId, chatId, text }) => {
				const sent = await api.sendMessage({
					business_connection_id: connectionId,
					chat_id: Number(chatId),
					text,
				});
				return sent.message_id;
			},
			typing: async ({ connectionId, chatId }) => {
				await api.sendChatAction({
					business_connection_id: connectionId,
					chat_id: Number(chatId),
					action: "typing",
				});
			},
		});
		void managerClient.start();
		visibility.setExclusive("manager", managerMatcher);
		visibility.setActive("manager", true);
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
		ctx.ui.notify(`Telegram manager: active (${subMode}).`);
	};

	pi.registerCommand(COMMANDS.managerObserver, {
		description:
			"Start the Telegram business manager in observer (co-pilot) sub-mode.",
		handler: (_args, ctx) => startManager(ctx, "observer"),
	});
	pi.registerCommand(COMMANDS.managerTakeover, {
		description:
			"Start the Telegram business manager in takeover (auto-reply) sub-mode.",
		handler: (_args, ctx) => startManager(ctx, "takeover"),
	});
	pi.registerCommand(COMMANDS.managerStop, {
		description: "Stop the Telegram business manager (mode 2).",
		handler: async (_args, ctx) => {
			if (!manager) {
				ctx.ui.notify("Telegram manager is not active.", "warning");
				return;
			}
			await stopManager();
			ctx.ui.notify("Telegram manager: stopped.");
		},
	});
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
