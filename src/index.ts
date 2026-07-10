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
import { COMMANDS } from "./constants";
import { AbortRegistry } from "./core/abort";
import { createAttachmentTools, TELEGRAM_TOOL_NAMES } from "./core/attachments";
import { createLifecycleController, pidIsAlive } from "./core/lifecycle";
import { ConnectController } from "./modes/connect/controller";
import { resolveTelegramPaths } from "./pi/agent-dir";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi/sdk";
import {
	createToolVisibility,
	registerToolVisibility,
} from "./pi/tool-visibility";
import { loadSettings } from "./settings/manager";
import { resolveSecret } from "./settings/secret";
import { createNodeFs } from "./storage/fs";
import { createSingletonStore } from "./storage/singleton-store";
import { fileBaseUrl, TelegramClient } from "./telegram/client";
import { type OutboundApi, OutboundSender } from "./telegram/outbound";

const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const TYPING_REFRESH_MS = 4_000;
const STATUS_KEY = "telegram";

export default function piTelegramManagerExtension(pi: ExtensionAPI): void {
	const fs = createNodeFs();
	const paths = resolveTelegramPaths();
	const singletonStore = createSingletonStore(fs, paths.singletonPath);
	const lifecycle = createLifecycleController({
		store: singletonStore,
		now: () => Date.now(),
		ownPid: process.pid,
		isPidAlive: pidIsAlive,
		heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
	});
	const abort = new AbortRegistry();
	const visibility = createToolVisibility(pi, TELEGRAM_TOOL_NAMES);
	registerToolVisibility(pi, visibility);

	// Live connect-mode runtime (null when inactive).
	let connect: ConnectController | null = null;
	let client: TelegramClient | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let busy = false;

	const sendFollowUp = async (text: string): Promise<void> => {
		await pi.sendUserMessage(text, { deliverAs: "followUp" });
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

	const stopConnect = async (ctx: ExtensionCommandContext): Promise<void> => {
		stopTyping();
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		await client?.stop().catch(() => {});
		client = null;
		connect = null;
		await lifecycle.deactivate("connect");
		visibility.setActive(false);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("agent_start", async (_event, ctx) => {
		busy = true;
		connect?.onAgentStart(() => ctx.abort());
		startTyping();
	});
	pi.on("agent_end", async (event) => {
		busy = false;
		stopTyping();
		await connect?.onAgentEnd(event.messages);
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
			const outbound = new OutboundSender(client.api as unknown as OutboundApi);
			connect = new ConnectController({
				allowedUserId,
				maxBytes: settings.files.maxBytes,
				isIdle: () => !busy,
				sendFollowUp,
				outbound,
				abort,
			});
			void fileBaseUrl(token); // reserved for media downloads (Phase 5)
			void client.start();
			heartbeat = setInterval(() => {
				void lifecycle.heartbeat();
			}, HEARTBEAT_INTERVAL_MS);
			visibility.setActive(true);
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
			ctx.ui.notify(
				"/telegram-manager is not implemented yet (Phase 4).",
				"warning",
			);
		},
	});
	pi.registerCommand(COMMANDS.managerStop, {
		description: "Stop the Telegram business manager (mode 2).",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"/telegram-manager-stop is not implemented yet (Phase 4).",
				"warning",
			);
		},
	});
}
