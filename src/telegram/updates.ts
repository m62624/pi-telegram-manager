/**
 * Classify a raw grammY/Telegram `Update` into a small, discriminated domain
 * event the rest of the extension routes on. This is a pure function — no I/O,
 * no SDK — so it is trivially unit-testable and keeps the grammY `Update`
 * shape from leaking into the controllers.
 *
 * We only surface the update kinds either mode acts on:
 *  - `message` / `edited_message`      — mode 1 (terminal continuation) DMs;
 *  - `business_*`                       — mode 2 (business manager);
 *  - `callback_query`                   — inline menus (phase 5).
 * Everything else collapses to a single `ignored` event carrying the update's
 * type name, so an unexpected update is dropped deliberately, not by omission.
 */
import type {
	BusinessConnection,
	BusinessMessagesDeleted,
	CallbackQuery,
	Message,
	Update,
} from "@grammyjs/types";

export type TelegramEvent =
	| IncomingMessageEvent
	| EditedMessageEvent
	| BusinessMessageEvent
	| EditedBusinessMessageEvent
	| DeletedBusinessMessagesEvent
	| BusinessConnectionEvent
	| CallbackQueryEvent
	| IgnoredEvent;

/** A new direct message to the bot (mode 1). */
export interface IncomingMessageEvent {
	kind: "message";
	message: Message;
	chatId: number;
	fromId?: number;
}

/** An edit of a known direct message (mode 1 — re-target the queued turn). */
export interface EditedMessageEvent {
	kind: "edited_message";
	message: Message;
	chatId: number;
	fromId?: number;
	editDate: number;
}

/** A new message arriving at a connected business account (mode 2). */
export interface BusinessMessageEvent {
	kind: "business_message";
	message: Message;
	chatId: number;
	connectionId: string;
	fromId?: number;
}

/** An edit of a business-account message (mode 2 — keep stored history consistent). */
export interface EditedBusinessMessageEvent {
	kind: "edited_business_message";
	message: Message;
	chatId: number;
	connectionId: string;
	fromId?: number;
	editDate: number;
}

/** Messages were deleted from a business account (mode 2 — prune stored history). */
export interface DeletedBusinessMessagesEvent {
	kind: "deleted_business_messages";
	connectionId: string;
	chatId: number;
	messageIds: number[];
}

/** The bot was connected to / disconnected from / re-configured on a business account. */
export interface BusinessConnectionEvent {
	kind: "business_connection";
	connection: BusinessConnection;
	connectionId: string;
	isEnabled: boolean;
}

/** An inline-keyboard button press. */
export interface CallbackQueryEvent {
	kind: "callback_query";
	query: CallbackQuery;
	fromId: number;
	data?: string;
	chatId?: number;
}

/** Any update we deliberately drop, tagged with the update's field name. */
export interface IgnoredEvent {
	kind: "ignored";
	updateType: string;
}

/** The name of the single populated optional field on an update, or "unknown". */
export function updateType(update: Update): string {
	for (const key of Object.keys(update)) {
		if (key !== "update_id" && update[key as keyof Update] !== undefined) {
			return key;
		}
	}
	return "unknown";
}

/** Classify a grammY/Telegram update into a domain event. Never throws. */
export function classifyUpdate(update: Update): TelegramEvent {
	if (update.message) {
		return {
			kind: "message",
			message: update.message,
			chatId: update.message.chat.id,
			fromId: update.message.from?.id,
		};
	}
	if (update.edited_message) {
		return {
			kind: "edited_message",
			message: update.edited_message,
			chatId: update.edited_message.chat.id,
			fromId: update.edited_message.from?.id,
			editDate: update.edited_message.edit_date,
		};
	}
	if (update.business_message) {
		return {
			kind: "business_message",
			message: update.business_message,
			chatId: update.business_message.chat.id,
			connectionId: update.business_message.business_connection_id ?? "",
			fromId: update.business_message.from?.id,
		};
	}
	if (update.edited_business_message) {
		return {
			kind: "edited_business_message",
			message: update.edited_business_message,
			chatId: update.edited_business_message.chat.id,
			connectionId: update.edited_business_message.business_connection_id ?? "",
			fromId: update.edited_business_message.from?.id,
			editDate: update.edited_business_message.edit_date,
		};
	}
	if (update.deleted_business_messages) {
		const deleted: BusinessMessagesDeleted = update.deleted_business_messages;
		return {
			kind: "deleted_business_messages",
			connectionId: deleted.business_connection_id,
			chatId: deleted.chat.id,
			messageIds: deleted.message_ids,
		};
	}
	if (update.business_connection) {
		return {
			kind: "business_connection",
			connection: update.business_connection,
			connectionId: update.business_connection.id,
			isEnabled: update.business_connection.is_enabled,
		};
	}
	if (update.callback_query) {
		const query = update.callback_query;
		return {
			kind: "callback_query",
			query,
			fromId: query.from.id,
			data: query.data,
			chatId: query.message?.chat.id,
		};
	}
	return { kind: "ignored", updateType: updateType(update) };
}
