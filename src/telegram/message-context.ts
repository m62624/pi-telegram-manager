/**
 * Extract cross-message context from a raw Telegram message: whether it was
 * forwarded (and from whom), what it replies to in the same chat, a quoted
 * excerpt, or a reply to a message in another chat. The bot receives all of
 * this on the normal message object — in private chats (mode 1) and business
 * chats (mode 2) alike — so this pure extractor is shared by both modes and the
 * rendering lives in `core/turns.ts` (`buildContextLines`).
 */
import type {
	Chat,
	ExternalReplyInfo,
	Message,
	MessageOrigin,
	User,
} from "@grammyjs/types";
import type { MessageContext } from "../core/turns";
import { extractProfileFromUser } from "./profile";

/** A human name for a chat: title (group/channel), first name (private), or @username. */
function chatDisplayName(chat: Chat): string {
	const named = chat as {
		title?: string;
		first_name?: string;
		username?: string;
	};
	if (named.title) return `«${named.title}»`;
	if (named.first_name) return named.first_name;
	if (named.username) return `@${named.username}`;
	return `chat ${chat.id}`;
}

/** Describe where a forwarded/origin message originally came from. */
export function describeMessageOrigin(origin: MessageOrigin): string {
	switch (origin.type) {
		case "user":
			return extractProfileFromUser(origin.sender_user).displayName;
		case "hidden_user":
			return `${origin.sender_user_name} (hidden)`;
		case "chat": {
			const name = chatDisplayName(origin.sender_chat);
			return origin.author_signature
				? `${name} (${origin.author_signature})`
				: name;
		}
		case "channel": {
			const name = `channel ${chatDisplayName(origin.chat)}`;
			return origin.author_signature
				? `${name} (${origin.author_signature})`
				: name;
		}
	}
}

/** The visible text a (reply) message carries — body or caption. */
function replyText(message: Message): string {
	const media = message as {
		text?: string;
		caption?: string;
		photo?: unknown;
		document?: { file_name?: string };
		video?: unknown;
		voice?: unknown;
		audio?: unknown;
		sticker?: { emoji?: string };
	};
	if (media.text) return media.text;
	if (media.caption) return media.caption;
	if (media.photo) return "<photo>";
	if (media.video) return "<video>";
	if (media.voice) return "<voice message>";
	if (media.audio) return "<audio>";
	if (media.sticker) return `<sticker ${media.sticker.emoji ?? ""}>`.trim();
	if (media.document)
		return media.document.file_name
			? `<file ${media.document.file_name}>`
			: "<file>";
	return "";
}

/** The media kind an external-reply carries, for a compact description. */
function externalReplyKind(info: ExternalReplyInfo): string {
	if (info.photo) return "a photo";
	if (info.video) return "a video";
	if (info.document) return "a file";
	if (info.audio) return "an audio";
	if (info.voice) return "a voice message";
	if (info.animation) return "an animation";
	if (info.sticker) return "a sticker";
	if (info.story) return "a story";
	if (info.location) return "a location";
	if (info.poll) return "a poll";
	return "a message";
}

/**
 * Whether a `reply_to_message` is just the topic's root rather than something the
 * sender chose to answer. Inside a forum topic Telegram anchors messages to the
 * topic-creation service message, so without this every message written in a topic
 * would carry a phantom `[reply to <bot>]: ""` into the model's context.
 */
export function isTopicAnchor(message: Message, replyTo: Message): boolean {
	if (replyTo.forum_topic_created) return true;
	return (
		message.is_topic_message === true &&
		message.message_thread_id !== undefined &&
		replyTo.message_id === message.message_thread_id
	);
}

/** Extract the cross-message context the model should see, mode-independent. */
export function extractMessageContext(message: Message): MessageContext {
	const context: MessageContext = {};

	if (message.forward_origin) {
		context.forwardedFrom = describeMessageOrigin(message.forward_origin);
	}

	const replyTo = message.reply_to_message;
	if (replyTo && !isTopicAnchor(message, replyTo)) {
		context.reply = {
			author: replyTo.from
				? extractProfileFromUser(replyTo.from as User).displayName
				: undefined,
			text: replyText(replyTo),
		};
	}

	if (message.quote?.text) {
		context.quote = message.quote.text;
	}

	if (message.external_reply) {
		context.externalReply = `${externalReplyKind(message.external_reply)} from ${describeMessageOrigin(
			message.external_reply.origin,
		)}`;
	}

	if (message.reply_to_story) {
		context.replyToStory = true;
	}

	return context;
}
