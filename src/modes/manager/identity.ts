/**
 * Tell a bot-sent business message from one the owner typed manually.
 *
 * In business mode the bot replies *on behalf of the owner* via
 * `business_connection_id`, so its own outgoing messages come back as updates
 * indistinguishable from the owner typing. The reply gate must not let
 * the bot's own messages freeze the chat, so every outgoing message carries two
 * bot signals:
 *
 *  1. its `message_id` is recorded in the {@link SentRegistry} (authoritative,
 *     but lost for ids evicted by retention or across a store wipe);
 *  2. a hidden zero-width marker is appended to the text (survives a restart and
 *     any id churn, invisible to humans).
 *
 * A message counts as bot-sent if *either* signal matches. The marker helpers
 * are pure; {@link isBotMessage} consults the async registry too.
 */
import type { SentRegistry } from "../../storage/sent-registry";

/**
 * A fixed, invisible zero-width signature appended to every bot message. Built
 * from word-joiner / zero-width-space code points that render as nothing and are
 * exceedingly unlikely to occur together in human text.
 */
export const BOT_MARKER = "\u2060\u200b\u2060\u200b\u2060";

/** Append the hidden bot marker to outgoing text. */
export function tagBotText(text: string): string {
	return `${text}${BOT_MARKER}`;
}

/** Whether text carries the hidden bot marker. */
export function hasBotMarker(text: string): boolean {
	return text.includes(BOT_MARKER);
}

/** Remove the hidden bot marker (e.g. before storing/displaying the text). */
export function stripBotMarker(text: string): string {
	return text.split(BOT_MARKER).join("");
}

/**
 * Whether an outgoing-from-owner business message was actually sent by the bot
 * (marker present, or id known to the registry) rather than typed by the owner.
 */
export async function isBotMessage(
	message: { chatId: string; messageId?: number; text?: string },
	registry: SentRegistry,
): Promise<boolean> {
	if (message.text && hasBotMarker(message.text)) return true;
	if (message.messageId === undefined) return false;
	return registry.wasSentByBot(message.chatId, message.messageId);
}
