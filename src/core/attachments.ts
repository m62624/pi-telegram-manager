/**
 * Tool that lets the model send a file to the bound Telegram chat:
 * `telegram_attach` (a file by local path or URL, with an optional caption).
 *
 * Mode 1 is a terminal *continuation* — the model's normal reply text is
 * mirrored to Telegram automatically on turn end, so there is deliberately NO
 * "send a text message" tool: the model just replies. Only files, which cannot
 * be mirrored from plain text, need an explicit tool.
 *
 * The tool is thin: it validates arguments and delegates to injected `deps`,
 * which the mode controller wires to an `OutboundSender` addressed at the active
 * chat. It is gated by `TELEGRAM_TOOL_NAMES` so it only appears while a mode is
 * active (see `pi/tool-visibility.ts`).
 */
import { defineTool, type ToolDefinition } from "../pi/sdk";

/** Names of the tools defined here — fed to the visibility gate. */
export const TELEGRAM_TOOL_NAMES = ["telegram_attach"] as const;

export interface AttachmentToolDeps {
	/** Send a file (exactly one of `path`/`url`) with an optional caption. */
	sendAttachment(input: {
		path?: string;
		url?: string;
		caption?: string;
	}): Promise<void>;
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

/** Build the outbound tools bound to `deps`. Register these with `pi.registerTool`. */
export function createAttachmentTools(
	deps: AttachmentToolDeps,
): ToolDefinition[] {
	const telegramAttach = defineTool({
		name: "telegram_attach",
		label: "Telegram Attachment",
		description:
			"Send a file to the current Telegram chat by local path or URL, with an optional caption. Provide exactly one of path or url.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Local file path to upload." },
				url: {
					type: "string",
					description: "HTTP(S) URL of the file to send.",
				},
				caption: { type: "string", description: "Optional caption." },
			},
			additionalProperties: false,
		} as never,
		async execute(
			_toolCallId,
			params: { path?: string; url?: string; caption?: string },
		) {
			const path = params.path?.trim();
			const url = params.url?.trim();
			if (!path && !url)
				return fail("telegram_attach requires either path or url.");
			if (path && url)
				return fail(
					"telegram_attach accepts only one of path or url, not both.",
				);
			try {
				await deps.sendAttachment({
					path,
					url,
					caption: params.caption?.trim() || undefined,
				});
			} catch (error) {
				// Surface the exact failure (missing file, too large, upload rejected)
				// so the model can explain it or retry differently.
				return fail(`telegram_attach failed: ${String(error)}`);
			}
			return ok("Attachment sent to Telegram.");
		},
	});

	return [telegramAttach];
}
