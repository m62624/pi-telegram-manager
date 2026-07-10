/**
 * pi-telegram-manager — composition root.
 *
 * The single Pi extension entrypoint (declared in package.json under
 * `pi.extensions`). It wires the tested domain pieces to the live Pi/grammY
 * runtime: builds shared infra (fs, paths, lifecycle, tool visibility), gates
 * the telegram tools, and registers the mode commands and agent-lifecycle
 * handlers.
 *
 * Mode 1 (terminal continuation) is wired here through `ConnectController`.
 * Mode 2 (business manager) is still a stub pending Phase 4.
 *
 * `isIdle` is tracked with a local `busy` flag flipped by agent_start/agent_end,
 * because Telegram updates arrive from the polling loop outside any Pi event
 * context; `sendUserMessage` is used from the top-level `pi` for the same
 * reason.
 */
import { COMMANDS, TELEGRAM_BOT_COMMANDS } from "./constants";
import { AbortRegistry } from "./core/abort";
import { createAttachmentTools, TELEGRAM_TOOL_NAMES } from "./core/attachments";
import { ContextReset } from "./core/context-reset";
import { createLifecycleController, pidIsAlive } from "./core/lifecycle";
import {
	classifyInputSource,
	shouldMirrorToTelegram,
} from "./core/prompt-origin";
import { ConnectController } from "./modes/connect/controller";
import { extractText, type PromptContent } from "./modes/connect/messages";
import { ManagerController } from "./modes/manager/controller";
import {
	createManagerTools,
	type DecisionSink,
	MANAGER_TOOL_NAMES,
} from "./modes/manager/decision";
import { resolveTelegramPaths } from "./pi/agent-dir";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";
import { createPiSession } from "./pi/session";
import {
	createToolVisibility,
	registerToolVisibility,
} from "./pi/tool-visibility";
import { loadSettings } from "./settings/manager";
import { resolveSecret } from "./settings/secret";
import { createBusinessStore } from "./storage/business-store";
import { createChatStore } from "./storage/chat-store";
import { createContactStore } from "./storage/contact-store";
import { createNodeFs } from "./storage/fs";
import { createSentRegistry } from "./storage/sent-registry";
import { createSingletonStore } from "./storage/singleton-store";
import {
	fetchBytesFromUrl,
	fileBaseUrl,
	TelegramClient,
} from "./telegram/client";
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

	// Rebuild the LLM context per mode: the manager replaces it with the active
	// chat's isolated history (mode 2); mode 1 applies the /clear boundary. No
	// mode / no boundary → leave the context untouched.
	pi.on("context", async (event) => {
		if (manager) {
			const isolated = await manager.buildContextForActive();
			if (!isolated) return {};
			return {
				messages: isolated.map((message) => ({
					role: message.role,
					content: message.content,
					timestamp: Date.now(),
				})),
			} as never;
		}
		const messages = contextReset.apply(event.messages);
		return messages ? { messages } : {};
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

	// Live manager-mode runtime (null when inactive).
	let manager: ManagerController | null = null;
	let managerClient: TelegramClient | null = null;
	let managerTick: ReturnType<typeof setInterval> | null = null;
	let managerHeartbeat: ReturnType<typeof setInterval> | null = null;
	let managerUi: {
		setWidget: ExtensionCommandContext["ui"]["setWidget"];
	} | null = null;

	const updateManagerBanner = (): void => {
		if (manager && managerUi) {
			managerUi.setWidget(
				MANAGER_BANNER_KEY,
				managerBannerLines(manager.status()),
			);
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
			// File upload is not wired yet; forward a URL/caption as a message so the
			// tool still does something useful. Local-path upload lands in Phase 5.
			const note = input.caption
				? `${input.caption}\n${input.url ?? input.path ?? ""}`.trim()
				: (input.url ?? input.path);
			if (note) await connect?.sendToChat(note);
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
			connect = new ConnectController({
				allowedUserId,
				maxBytes: settings.files.maxBytes,
				isIdle: () => !busy,
				sendFollowUp,
				loadImages,
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

	pi.registerCommand(COMMANDS.manager, {
		description: "Start the Telegram business manager (mode 2).",
		handler: async (_args, ctx) => {
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
				subMode: settings.manager.subMode,
			});
			if (!activation.ok) {
				ctx.ui.notify(`Cannot start manager: ${activation.reason}`, "error");
				return;
			}

			// Isolate the manager in its own Pi session/folder (best-effort — the
			// runtime still works in the current session if this is unavailable).
			try {
				const created = await createPiSession({
					fs,
					agentDir: paths.agentDir,
					cwd: paths.managerWorkspaceDir,
				});
				await ctx.switchSession(created.sessionFile);
			} catch (error) {
				ctx.ui.notify(
					`Manager session isolation skipped: ${String(error)}`,
					"warning",
				);
			}

			managerClient = new TelegramClient({
				token,
				onEvent: routeManagerEvent,
				onError: (error) =>
					ctx.ui.notify(`Telegram error: ${String(error)}`, "error"),
			});
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
				subMode: settings.manager.subMode,
				labeler: settings.manager.labeler,
				rememberMessages: settings.manager.rememberMessages,
				continueWindowMs: settings.manager.continueWindowMs,
				ownerReplyWindowMs: settings.manager.ownerReplyWindowMs,
				clock: { now: () => Date.now() },
				chatStore: createChatStore(fs, paths),
				contactStore,
				sentRegistry: createSentRegistry(fs, paths.sentRegistryPath),
				businessStore: createBusinessStore(fs, paths.businessPath),
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
			visibility.setActive("manager", true);
			managerUi = { setWidget: ctx.ui.setWidget.bind(ctx.ui) };
			updateManagerBanner();
			managerTick = setInterval(() => {
				void manager?.onTick().then(updateManagerBanner);
			}, MANAGER_TICK_MS);
			managerHeartbeat = setInterval(() => {
				void lifecycle.heartbeat();
			}, HEARTBEAT_INTERVAL_MS);
			ctx.ui.notify(`Telegram manager: active (${settings.manager.subMode}).`);
		},
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
