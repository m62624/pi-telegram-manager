/**
 * What the model is actually reading, measured on the way out.
 *
 * `pi.on("context")` is the last place the message array exists before it becomes a
 * prompt, and it is the only place that knows what we changed: the system block we
 * add, the history the manager replaces, the turns mixed mode strips. Pi's own
 * `getContextUsage()` reports one number for the whole thing, after the fact — which
 * is enough to know the context is filling up, and no help at all in knowing WHAT
 * filled it.
 *
 * So every context build is measured here, and `/context` reports the last one. The
 * question it answers is the one that costs a whole session when nobody can answer
 * it: the model forgot the beginning — was that a compaction, or a leak, or forty
 * files of tool output nobody counted?
 *
 * Sizes are in characters, which is a fact, and turned into tokens only at the edge
 * with the same chars/4 rule Pi's own estimator uses — an estimate, and labelled as
 * one. The exact count comes from the model, in `getContextUsage()`, and the card
 * shows both rather than pretending either is the whole truth.
 *
 * Pure and SDK-free.
 */
import { SYSTEM_INSTRUCTIONS_HEADER } from "../instructions/builtin";

/** Which build produced this context — the same three sources as `mixedContextSource`. */
export type ContextSource = "personal" | "mixed-coding" | "manager-chat";

/** A message as the context transform sees it (structurally an `AgentMessage`). */
export interface MeasurableMessage {
	role: string;
	content?: unknown;
}

/** The parts of a context, sized. Characters, never tokens — tokens are estimated later. */
export interface ContextSnapshot {
	source: ContextSource;
	/** When the context was built. */
	takenAt: number;
	/** Messages handed to the model, including the ones we added. */
	messages: number;
	counts: { user: number; assistant: number; tool: number; other: number };
	chars: {
		/** Our own standing instructions (the `[SYSTEM_INSTRUCTIONS]` head message). */
		instructions: number;
		/** What the owner/interlocutors said. */
		user: number;
		/** What the model said. */
		assistant: number;
		/** Tool output — the part that grows without anyone deciding to grow it. */
		tool: number;
	};
	/** Inline images (each one costs far more than its characters suggest). */
	images: number;
}

/** Total characters across every part. */
export function totalChars(snapshot: ContextSnapshot): number {
	const { instructions, user, assistant, tool } = snapshot.chars;
	return instructions + user + assistant + tool;
}

/**
 * Tokens from characters, by the same chars/4 rule Pi's compaction estimator uses.
 * It is a rough over-estimate for prose and a rough under-estimate for code; it is
 * never presented as anything but an estimate.
 */
export function estimateTokens(chars: number): number {
	return Math.round(chars / 4);
}

/** Measure one built context. Cheap: one pass, no copies. */
export function measureContext(
	source: ContextSource,
	messages: readonly MeasurableMessage[],
	takenAt: number,
): ContextSnapshot {
	const snapshot: ContextSnapshot = {
		source,
		takenAt,
		messages: messages.length,
		counts: { user: 0, assistant: 0, tool: 0, other: 0 },
		chars: { instructions: 0, user: 0, assistant: 0, tool: 0 },
		images: 0,
	};
	for (const message of messages) {
		const text = textOf(message.content);
		snapshot.images += imagesIn(message.content);
		if (isInstructions(message)) {
			snapshot.chars.instructions += text.length;
			// Not counted as anyone's turn: it is the standing brief, not the conversation.
			continue;
		}
		switch (message.role) {
			case "user":
				snapshot.counts.user += 1;
				snapshot.chars.user += text.length;
				break;
			case "assistant":
				snapshot.counts.assistant += 1;
				snapshot.chars.assistant += text.length;
				break;
			case "toolResult":
				snapshot.counts.tool += 1;
				snapshot.chars.tool += text.length;
				break;
			default:
				snapshot.counts.other += 1;
				snapshot.chars.assistant += text.length;
		}
	}
	return snapshot;
}

/** Whether a message is the bridge's own standing-instructions head block. */
function isInstructions(message: MeasurableMessage): boolean {
	return (
		message.role === "user" &&
		typeof message.content === "string" &&
		message.content.startsWith(SYSTEM_INSTRUCTIONS_HEADER)
	);
}

/** All the text of a message, whatever shape it carries it in. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && typeof block.text === "string"
				? block.text
				: // A tool CALL is text the model wrote too — its arguments are in the prompt.
					block && typeof block === "object" && "arguments" in block
					? safeJson((block as { arguments: unknown }).arguments)
					: "",
		)
		.join("");
}

function imagesIn(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter(
		(block) => block && typeof block === "object" && block.type === "image",
	).length;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}
