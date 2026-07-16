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
	 * Inline images for the newest incoming message (mode 2 vision). They live
	 * only in memory for the freshest turn — stored records keep just an `[image]`
	 * marker — so they attach to the last incoming line, if any. That line can be
	 * the OWNER's: when the owner summons the bot to look at a photo they sent or
	 * replied to, the picture belongs to their message, not to some earlier
	 * interlocutor one.
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
	let lastIncomingIndex = -1;
	if (input.boundary?.trim()) {
		messages.push({ role: "user", content: input.boundary.trim() });
	}
	for (const record of input.records) {
		const text = record.text?.trim() ?? "";
		// A message can be pure context — a reply carrying nothing but a photo — and
		// still matters: it is the turn the next one answers.
		if (!text && !record.context?.trim()) continue;
		if (record.author === "bot") {
			if (!text) continue;
			messages.push({ role: "assistant", content: text });
		} else {
			const label =
				record.author === "owner" ? labels.owner : labels.interlocutor;
			const who = record.senderName ? `${label} (${record.senderName})` : label;
			// Tag each incoming line with its Telegram message id so the model can
			// point `manager_reply.reply_to` at the exact message it answers.
			const tag =
				record.messageId !== undefined ? `[#${record.messageId}] ` : "";
			// The speaker is the prefix, and nothing else. Context (what they replied
			// to, what they quoted, who wrote a forward) hangs BELOW the line, marked
			// as such — inlined ahead of the words it read as the speaker's name.
			const context = record.context?.trim();
			const trailer = context
				? `\n${context
						.split("\n")
						.map((line) => `  ↳ ${line}`)
						.join("\n")}`
				: "";
			const spoken = text ? `${who}: ${text}` : `${who}:`;
			messages.push({ role: "user", content: `${tag}${spoken}${trailer}` });
			lastIncomingIndex = messages.length - 1;
		}
	}
	if (input.latestImages?.length && lastIncomingIndex >= 0) {
		messages[lastIncomingIndex].images = input.latestImages;
	}
	return messages;
}

/**
 * Trim a stored transcript to a CHARACTER budget before the model sees it, so a
 * single huge paste (or a long run of messages) can never blow a small local
 * model's context window — the last-N window is bounded by message COUNT alone
 * otherwise. Two independent caps, each disabled by a value <= 0:
 *  - `maxCharsPerMessage` truncates any one over-long message, appending a
 *    "…[+N chars]" marker so nothing looks silently lost;
 *  - `maxContextChars` drops the OLDEST messages until the kept text fits, always
 *    keeping at least the newest message (already capped above).
 *
 * Pure, and never touches disk — only the copy the model reads is trimmed.
 */
export function budgetRecords(
	records: readonly ChatMessageRecord[],
	maxCharsPerMessage: number,
	maxContextChars: number,
): ChatMessageRecord[] {
	const capped = records.map((record) => capRecord(record, maxCharsPerMessage));
	if (maxContextChars <= 0) return [...capped];
	const kept: ChatMessageRecord[] = [];
	let total = 0;
	for (let i = capped.length - 1; i >= 0; i -= 1) {
		total += capped[i].text?.length ?? 0;
		if (total > maxContextChars && kept.length > 0) break;
		kept.unshift(capped[i]);
	}
	return kept;
}

/** Truncate one over-long message, saying how much was left out. */
function capRecord(
	record: ChatMessageRecord,
	maxCharsPerMessage: number,
): ChatMessageRecord {
	const text = record.text ?? "";
	if (maxCharsPerMessage <= 0 || text.length <= maxCharsPerMessage)
		return record;
	const dropped = text.length - maxCharsPerMessage;
	return {
		...record,
		text: `${text.slice(0, maxCharsPerMessage)} …[+${dropped} chars]`,
	};
}

/**
 * How many messages the window sheds when it must shed any.
 *
 * The number is a trade, and both sides of it are real: a bigger block means the
 * transcript the model reads is stable for longer (cheaper turns), and that when it
 * finally moves it forgets more at once. Eight is two to four turns of stability, and
 * eight messages is not a conversation.
 */
export const WINDOW_BLOCK = 8;

/**
 * The transcript window: the newest messages, trimmed to the caps — and, crucially,
 * ANCHORED, so that its first line does not move every time somebody speaks.
 *
 * A plain last-N window slides by one message per message. That sounds harmless and is
 * not: the first line of the transcript is the first thing the model reads after the
 * standing rules, so when it changes, EVERYTHING under it has to be read again. The
 * bench (`tests/modes/manager/prefix-reuse.test.ts`) priced it — in a chat of
 * pasted-length messages, an ordinary turn re-read 9,328 characters on average and
 * 19,258 at worst, almost none of which was new.
 *
 * So the window's start is quantised to a grid of {@link WINDOW_BLOCK} messages. It stays
 * put while the conversation grows over it, and when it finally must move, it moves a
 * whole block at once — paying for one expensive turn and then being free again for
 * several. The window therefore holds between `maxMessages` and `maxMessages + block - 1`
 * records: never FEWER than configured, sometimes a few more, which is the right way for
 * this trade to err.
 *
 * `maxContextChars` still binds (a paste can be enormous), and when it does, it also
 * moves on the grid — dropping a whole block rather than one message, because a budget
 * that slides by one undoes the anchoring it is standing on. `maxCharsPerMessage`
 * truncates a single over-long message in place, which changes no one's position.
 *
 * Pure, and never touches disk: only the copy the model reads is trimmed.
 */
export function windowRecords(
	records: readonly ChatMessageRecord[],
	options: {
		maxMessages: number;
		maxCharsPerMessage: number;
		maxContextChars: number;
		block?: number;
	},
): ChatMessageRecord[] {
	const block = Math.max(1, options.block ?? WINDOW_BLOCK);
	const capped = records.map((record) =>
		capRecord(record, options.maxCharsPerMessage),
	);
	if (capped.length === 0) return [];

	const overflow =
		options.maxMessages > 0
			? Math.max(0, capped.length - options.maxMessages)
			: 0;
	let start = block * Math.floor(overflow / block);

	if (options.maxContextChars > 0) {
		const last = capped.length - 1;
		// The newest message is never dropped, however long it is: a turn with nothing in
		// it is not a cheaper turn, it is a broken one.
		while (start < last && charsFrom(capped, start) > options.maxContextChars) {
			start += block;
		}
		if (start > last) start = last;
	}
	return capped.slice(start);
}

function charsFrom(
	records: readonly ChatMessageRecord[],
	start: number,
): number {
	let total = 0;
	for (let i = start; i < records.length; i += 1) {
		total += records[i].text?.length ?? 0;
	}
	return total;
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
