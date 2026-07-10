/**
 * Tools that let the model send extra content to the bound Telegram chat,
 * beyond its normal reply text: `telegram_message` (an interstitial
 * text/markdown message) and `telegram_attach` (a file by local path or URL).
 *
 * The tools are thin: they validate arguments and delegate to injected `deps`,
 * which the mode controller wires to an `OutboundSender` addressed at the
 * active chat. That keeps the send target and transport out of here, so the
 * tool logic (argument validation, result shape) is unit-testable with fakes.
 *
 * Both tools are gated by `TELEGRAM_TOOL_NAMES` so they only appear to the
 * model while a mode is active (see `pi/tool-visibility.ts`).
 */
import { defineTool, type ToolDefinition } from "../pi/sdk";

/** Names of the tools defined here — fed to the visibility gate. */
export const TELEGRAM_TOOL_NAMES = [
	"telegram_message",
	"telegram_attach",
] as const;

export interface AttachmentToolDeps {
	/** Send a text/markdown message to the active chat now. */
	sendMessage(text: string): Promise<void>;
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
	const telegramMessage = defineTool({
		name: "telegram_message",
		label: "Telegram Message",
		description:
			"Send an extra text/markdown message to the current Telegram chat immediately, separate from your normal reply.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "Message text (Telegram-flavored markdown).",
				},
			},
			required: ["text"],
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params: { text: string }) {
			const text = params.text?.trim();
			if (!text) return fail("telegram_message requires non-empty text.");
			await deps.sendMessage(text);
			return ok("Message sent to Telegram.");
		},
	});

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
			await deps.sendAttachment({
				path,
				url,
				caption: params.caption?.trim() || undefined,
			});
			return ok("Attachment sent to Telegram.");
		},
	});

	return [telegramMessage, telegramAttach];
}
