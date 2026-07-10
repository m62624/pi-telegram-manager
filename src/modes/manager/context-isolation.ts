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

/** A rebuilt message, structurally a subset of the SDK's user/assistant message. */
export interface IsolatedMessage {
	role: "user" | "assistant";
	content: string;
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
		}
	}
	return messages;
}

/** The default boundary directive shown when switching to a chat. */
export function boundaryDirective(contactName: string): string {
	return `[New chat with ${contactName}. This is a separate conversation; previous chats are not available.]`;
}
