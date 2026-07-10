/**
 * Rebuild the message array the model sees for the active chat, so one shared
 * agent session never leaks one interlocutor's conversation into another's.
 *
 * The manager keeps every chat's transcript in the ACID {@link ChatMessageRecord}
 * store. When the active chat changes (only ever while the agent is idle, so no
 * tool_use/tool_result pair is split), the runtime replaces the session's
 * messages with *only* this chat's last-N history, rebuilt here: a boundary
 * directive marking a fresh conversation, then each stored turn mapped to a
 * user/assistant message. Other chats' turns are structurally absent — isolation
 * is by construction, not by asking the model to forget.
 *
 * This is the pure core (records → messages); the runtime maps the result onto
 * the SDK's `AgentMessage` shape inside `pi.on("context")`.
 */
import type { ChatMessageRecord } from "../../storage/chat-store";

/** An inline image part (structurally the SDK's `ImageContent`). */
export interface IsolatedImage {
	data: string;
	mimeType: string;
}

/** A rebuilt message, structurally a subset of the SDK's user/assistant message. */
export interface IsolatedMessage {
	role: "user" | "assistant";
	content: string;
	/** Inline images to attach to a user message (interlocutor pictures, mode 2). */
	images?: IsolatedImage[];
}

export interface IsolationLabels {
	/** Prefix for interlocutor messages (default "Interlocutor"). */
	interlocutor: string;
	/** Prefix for the owner's own messages (default "Owner"). */
	owner: string;
}

const DEFAULT_LABELS: IsolationLabels = {
	interlocutor: "Interlocutor",
	owner: "Owner",
};

export interface BuildIsolatedInput {
	records: readonly ChatMessageRecord[];
	/**
	 * A system directive prepended as the first user message when the active chat
	 * changes, e.g. "[New chat with Alice. Previous conversations are not
	 * available.]". Omitted → no boundary line.
	 */
	boundary?: string;
	labels?: Partial<IsolationLabels>;
	/**
	 * Inline images for the newest interlocutor message (mode 2 vision). They live
	 * only in memory for the freshest turn — stored records keep just an `[image]`
	 * marker — so they attach to the last interlocutor line, if any.
	 */
	latestImages?: IsolatedImage[];
}

/**
 * Map the active chat's stored transcript to an isolated message array. Bot
 * turns become assistant messages; interlocutor/owner turns become labelled user
 * messages so the model always knows who spoke. Empty-text records are skipped.
 */
export function buildIsolatedMessages(
	input: BuildIsolatedInput,
): IsolatedMessage[] {
	const labels = { ...DEFAULT_LABELS, ...input.labels };
	const messages: IsolatedMessage[] = [];
	let lastInterlocutorIndex = -1;
	if (input.boundary?.trim()) {
		messages.push({ role: "user", content: input.boundary.trim() });
	}
	for (const record of input.records) {
		const text = record.text?.trim();
		if (!text) continue;
		if (record.author === "bot") {
			messages.push({ role: "assistant", content: text });
		} else {
			const label =
				record.author === "owner" ? labels.owner : labels.interlocutor;
			const who = record.senderName ? `${label} (${record.senderName})` : label;
			messages.push({ role: "user", content: `${who}: ${text}` });
			if (record.author === "interlocutor")
				lastInterlocutorIndex = messages.length - 1;
		}
	}
	if (input.latestImages?.length && lastInterlocutorIndex >= 0) {
		messages[lastInterlocutorIndex].images = input.latestImages;
	}
	return messages;
}

/** The default boundary directive shown when switching to a chat. */
export function boundaryDirective(contactName: string): string {
	return `[New chat with ${contactName}. This is a separate conversation; previous chats are not available.]`;
}

/** A text content block (structurally the SDK's `TextContent`). */
export interface TextBlock {
	type: "text";
	text: string;
}

/** An image content block (structurally the SDK's `ImageContent`). */
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * A rebuilt user message for the SDK's context event. Plain text stays a string;
 * a message carrying images becomes a mixed `[image…, text]` block array so the
 * model can actually see the picture (mode 2 vision).
 */
export interface RebuiltUserMessage {
	role: "user";
	content: string | Array<ImageBlock | TextBlock>;
	timestamp: number;
}

/**
 * A rebuilt assistant message for the SDK's context event. It MUST carry
 * block-array content and a `usage` object: the SDK's token estimator iterates
 * assistant content as blocks and reads `usage.totalTokens` unguarded, so a
 * string body or a missing `usage` crashes it ("Cannot read properties of
 * undefined (reading 'totalTokens')"). Zero usage is skipped by the estimator.
 */
export interface RebuiltAssistantMessage {
	role: "assistant";
	content: { type: "text"; text: string }[];
	timestamp: number;
	stopReason: "stop";
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	};
}

export type RebuiltMessage = RebuiltUserMessage | RebuiltAssistantMessage;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
} as const;

/**
 * Map the isolated (role, string) messages onto the well-formed shape the SDK's
 * context event expects, so token estimation over our synthetic transcript
 * never crashes. Assistant turns become block-array content with a zero `usage`;
 * user turns keep their string content.
 */
export function toRebuiltMessages(
	messages: readonly IsolatedMessage[],
	now: number,
): RebuiltMessage[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: "assistant",
				content: [{ type: "text", text: message.content }],
				timestamp: now,
				stopReason: "stop",
				usage: { ...ZERO_USAGE },
			};
		}
		if (message.images?.length) {
			return {
				role: "user",
				content: [
					...message.images.map(
						(image): ImageBlock => ({
							type: "image",
							data: image.data,
							mimeType: image.mimeType,
						}),
					),
					{ type: "text", text: message.content },
				],
				timestamp: now,
			};
		}
		return { role: "user", content: message.content, timestamp: now };
	});
}
