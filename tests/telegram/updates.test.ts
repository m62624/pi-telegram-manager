import type { Message, Update } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import { classifyUpdate, updateType } from "../../src/telegram/updates";

/** Minimal message fixture; only the fields the classifier reads matter. */
function message(overrides: Partial<Message> = {}): Message {
	return {
		message_id: 1,
		date: 1_700_000_000,
		chat: { id: 555, type: "private", first_name: "A" },
		from: { id: 777, is_bot: false, first_name: "A" },
		text: "hi",
		...overrides,
	} as Message;
}

function update(fields: Partial<Update>): Update {
	return { update_id: 10, ...fields } as Update;
}

describe("classifyUpdate", () => {
	it("classifies a direct message with chat and sender ids", () => {
		const event = classifyUpdate(update({ message: message() }));
		expect(event).toMatchObject({ kind: "message", chatId: 555, fromId: 777 });
	});

	it("classifies an edited message and carries the edit date", () => {
		const event = classifyUpdate(
			update({
				edited_message: message({ edit_date: 1_700_000_500 }) as Message,
			}),
		);
		expect(event).toMatchObject({
			kind: "edited_message",
			editDate: 1_700_000_500,
		});
	});

	it("classifies a business message with its connection id", () => {
		const event = classifyUpdate(
			update({
				business_message: message({ business_connection_id: "conn-1" }),
			}),
		);
		expect(event).toMatchObject({
			kind: "business_message",
			connectionId: "conn-1",
			chatId: 555,
		});
	});

	it("classifies an edited business message", () => {
		const event = classifyUpdate(
			update({
				edited_business_message: message({
					business_connection_id: "conn-1",
					edit_date: 1_700_000_900,
				}) as Message,
			}),
		);
		expect(event).toMatchObject({
			kind: "edited_business_message",
			connectionId: "conn-1",
			editDate: 1_700_000_900,
		});
	});

	it("classifies deleted business messages with the id list", () => {
		const event = classifyUpdate(
			update({
				deleted_business_messages: {
					business_connection_id: "conn-1",
					chat: { id: 42, type: "private", first_name: "A" },
					message_ids: [3, 4, 5],
				},
			}),
		);
		expect(event).toEqual({
			kind: "deleted_business_messages",
			connectionId: "conn-1",
			chatId: 42,
			messageIds: [3, 4, 5],
		});
	});

	it("classifies a business connection and exposes its enabled flag", () => {
		const event = classifyUpdate(
			update({
				business_connection: {
					id: "conn-1",
					user: { id: 1, is_bot: false, first_name: "Owner" },
					user_chat_id: 1,
					date: 1_700_000_000,
					is_enabled: true,
				},
			}),
		);
		expect(event).toMatchObject({
			kind: "business_connection",
			connectionId: "conn-1",
			isEnabled: true,
		});
	});

	it("classifies a callback query with its data and origin chat", () => {
		const event = classifyUpdate(
			update({
				callback_query: {
					id: "cbq-1",
					from: { id: 777, is_bot: false, first_name: "A" },
					chat_instance: "ci",
					data: "menu:open",
					message: message(),
				},
			}),
		);
		expect(event).toMatchObject({
			kind: "callback_query",
			fromId: 777,
			data: "menu:open",
			chatId: 555,
		});
	});

	it("collapses an unhandled update to an ignored event with its type name", () => {
		const event = classifyUpdate(
			update({ poll_answer: { poll_id: "p", option_ids: [0] } }),
		);
		expect(event).toEqual({ kind: "ignored", updateType: "poll_answer" });
	});

	it("reports 'unknown' for an update with no recognizable field", () => {
		expect(updateType({ update_id: 1 } as Update)).toBe("unknown");
	});
});
