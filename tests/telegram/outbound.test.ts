import { describe, expect, it } from "vitest";
import { OutboundSender } from "../../src/telegram/outbound";
import { heading, RichHtmlDocument } from "../../src/telegram/rich-builder";
import { FakeOutboundApi } from "../helpers/fake-outbound-api";

describe("OutboundSender", () => {
	it("renders markdown via the fast-path and returns the sent id", async () => {
		const api = new FakeOutboundApi(1000);
		const sender = new OutboundSender(api);
		const ids = await sender.sendMarkdown({ chatId: 555 }, "hello \\( x \\)");
		expect(ids).toEqual([1000]);
		expect(api.sent).toHaveLength(1);
		expect(api.sent[0]).toEqual({
			chat_id: 555,
			rich_message: { markdown: "hello $ x $" },
		});
	});

	it("omits business_connection_id for a plain target", async () => {
		const api = new FakeOutboundApi();
		await new OutboundSender(api).sendMarkdown({ chatId: 1 }, "hi");
		expect(api.sent[0]).not.toHaveProperty("business_connection_id");
	});

	it("includes business and thread routing keys when present", async () => {
		const api = new FakeOutboundApi();
		await new OutboundSender(api).sendMarkdown(
			{ chatId: 7, businessConnectionId: "conn-1", messageThreadId: 42 },
			"hi",
		);
		expect(api.sent[0]).toMatchObject({
			chat_id: 7,
			business_connection_id: "conn-1",
			message_thread_id: 42,
		});
	});

	it("sends one message per rendered chunk and returns ids in order", async () => {
		const api = new FakeOutboundApi(500);
		const renderer = (text: string) =>
			text.split("|").map((markdown) => ({ markdown }));
		const sender = new OutboundSender(api, { renderer });
		const ids = await sender.sendMarkdown({ chatId: 9 }, "a|b|c");
		expect(ids).toEqual([500, 501, 502]);
		expect(api.sent.map((s) => s.rich_message)).toEqual([
			{ markdown: "a" },
			{ markdown: "b" },
			{ markdown: "c" },
		]);
	});

	it("sends pre-built rich messages from a document", async () => {
		const api = new FakeOutboundApi();
		const message = new RichHtmlDocument().heading("Report").build();
		await new OutboundSender(api).sendMessages({ chatId: 3 }, [message]);
		expect(api.sent[0].rich_message).toEqual({ html: "<h2>Report</h2>" });
	});

	it("escapes a plain notice and passes built html through", async () => {
		const api = new FakeOutboundApi();
		const sender = new OutboundSender(api);
		await sender.notify({ chatId: 1 }, "a < b");
		await sender.notify({ chatId: 1 }, heading("Hi"));
		expect(api.sent[0].rich_message).toEqual({ html: "a &lt; b" });
		expect(api.sent[1].rich_message).toEqual({ html: "<h2>Hi</h2>" });
	});

	it("broadcasts a chat action, defaulting to typing", async () => {
		const api = new FakeOutboundApi();
		const sender = new OutboundSender(api);
		await sender.chatAction({ chatId: 1, businessConnectionId: "c" });
		await sender.chatAction({ chatId: 1 }, "upload_photo");
		expect(api.actions).toEqual([
			{ chat_id: 1, business_connection_id: "c", action: "typing" },
			{ chat_id: 1, action: "upload_photo" },
		]);
	});

	it("pushes a streaming draft", async () => {
		const api = new FakeOutboundApi();
		await new OutboundSender(api).draft({ chatId: 2 }, { markdown: "partial" });
		expect(api.drafts[0]).toEqual({
			chat_id: 2,
			rich_message: { markdown: "partial" },
		});
		expect(api.sent).toHaveLength(0);
	});
});
