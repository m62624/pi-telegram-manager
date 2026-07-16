/**
 * Extracting the tail of a Pi session for the `/resume` history preview.
 *
 * When the owner resumes a DIFFERENT session, the Telegram topic is otherwise blank
 * about what they just restored: the terminal shows the whole conversation (Pi loads it
 * natively), but the chat shows nothing, so there is no way to tell from the phone which
 * history is now live. This pulls the last few user/assistant exchanges so `index.ts`
 * can replay them into the personal topic as display-only cards — for the owner's eyes
 * only, never fed back to the agent and never echoed to the terminal.
 *
 * Pure over a structural message shape (no SDK, no grammY), so it is unit-testable on
 * plain fakes. Tool calls and tool results are dropped — only what a person reads as
 * conversation survives — and the hidden Telegram-turn marker is stripped so a replayed
 * prompt reads clean.
 */
import { MIXED_TELEGRAM_MARKER } from "../modes/manager/mixed-context";

/** A content block of a message (structural subset of the SDK's blocks). */
interface ContentBlock {
	type?: string;
	text?: string;
	/** An `image` block carries base64 bytes (Pi stores exactly what we sent). */
	data?: string;
	mimeType?: string;
}

/** The minimal message shape the extractor reads (structurally an `AgentMessage`). */
export interface TailSourceMessage {
	role: string;
	content?: string | ContentBlock[] | unknown;
}

/** An image carried by a replayed message, so a reply to its card can re-deliver it. */
export interface TailImage {
	data: string;
	mimeType: string;
}

/** One replayable line: whose it was, its (already-cleaned) text, and any pictures. */
export interface TailMessage {
	role: "user" | "assistant";
	text: string;
	/** Base64 images the message carried, verbatim from the session (may be empty). */
	images: TailImage[];
}

/** How long one replayed message may be before it is truncated. */
export const TAIL_MESSAGE_MAX_LEN = 500;

/** Shown for a message that carried only a picture and no words. */
const PHOTO_PLACEHOLDER = "[photo]";

/**
 * The last {@link maxMessages} user/assistant messages of a session, oldest-first, each
 * with clean text AND any images it carried (base64, verbatim — Pi stores images in the
 * same `{type,data,mimeType}` shape we send). A message is kept when it has readable text
 * OR a picture, so a photo-only turn still becomes a card a reply can point at; tool calls
 * and tool results carry neither and are dropped. Truncation keeps one post from dwarfing
 * the topic; images are never truncated, only the caption is.
 */
export function extractSessionTail(
	messages: readonly TailSourceMessage[],
	maxMessages: number,
): TailMessage[] {
	const out: TailMessage[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = cleanText(flattenText(message.content));
		const images = extractImages(message.content);
		if (!text && images.length === 0) continue;
		out.push({
			role: message.role,
			text: text ? truncate(text, TAIL_MESSAGE_MAX_LEN) : PHOTO_PLACEHOLDER,
			images,
		});
	}
	return out.slice(Math.max(0, out.length - Math.max(0, maxMessages)));
}

/** Pull the base64 images out of a message's content, verbatim, in order. */
function extractImages(content: TailSourceMessage["content"]): TailImage[] {
	if (!Array.isArray(content)) return [];
	const images: TailImage[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			block.type === "image" &&
			typeof block.data === "string" &&
			block.data
		) {
			images.push({
				data: block.data,
				mimeType:
					typeof block.mimeType === "string" ? block.mimeType : "image/jpeg",
			});
		}
	}
	return images;
}

/** Flatten a message's text so it can be read regardless of block/string shape. */
function flattenText(content: TailSourceMessage["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block && typeof block === "object" && typeof block.text === "string"
					? block.text
					: "",
			)
			.join("");
	}
	return "";
}

/** Drop the hidden Telegram-turn marker and collapse whitespace to one clean line. */
function cleanText(value: string): string {
	return value
		.split(MIXED_TELEGRAM_MARKER)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}
