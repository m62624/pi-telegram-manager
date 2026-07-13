import type { Update } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { AbortRegistry } from "../../../src/core/abort";
import {
	ConnectController,
	type ConnectControllerDeps,
} from "../../../src/modes/connect/controller";
import { OutboundSender } from "../../../src/telegram/outbound";
import { RichHtml, thinking } from "../../../src/telegram/rich-builder";
import {
	classifyUpdate,
	type TelegramEvent,
} from "../../../src/telegram/updates";
import { FakeOutboundApi } from "../../helpers/fake-outbound-api";

const ALLOWED = 777;

function messageEvent(
	text: string,
	messageId = 1,
	fromId = ALLOWED,
): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		message: {
			message_id: messageId,
			date: 0,
			chat: { id: fromId, type: "private", first_name: "A" },
			from: { id: fromId, is_bot: false, first_name: "Ada" },
			text,
		},
	} as Update);
}

function editedEvent(text: string, messageId: number): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		edited_message: {
			message_id: messageId,
			date: 0,
			edit_date: 1,
			chat: { id: ALLOWED, type: "private", first_name: "A" },
			from: { id: ALLOWED, is_bot: false, first_name: "Ada" },
			text,
		},
	} as Update);
}

function setup(overrides: Partial<ConnectControllerDeps> = {}) {
	const api = new FakeOutboundApi();
	const abort = new AbortRegistry();
	const sendFollowUp = vi.fn(async () => {});
	let idle = true;
	const deps: ConnectControllerDeps = {
		allowedUserId: ALLOWED,
		maxBytes: 1000,
		isIdle: () => idle,
		sendFollowUp,
		outbound: new OutboundSender(api),
		abort,
		...overrides,
	};
	const controller = new ConnectController(deps);
	return {
		controller,
		api,
		abort,
		sendFollowUp,
		setIdle: (v: boolean) => (idle = v),
	};
}

describe("ConnectController", () => {
	it("ignores messages from an unauthorized user", async () => {
		const { controller, sendFollowUp } = setup();
		const handled = await controller.onEvent(messageEvent("hi", 1, 999));
		expect(handled).toBe(false);
		expect(sendFollowUp).not.toHaveBeenCalled();
	});

	it("dispatches an authorized message immediately when idle", async () => {
		const { controller, sendFollowUp } = setup();
		await controller.onEvent(messageEvent("hello"));
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("hello");
		expect(controller.pendingCount()).toBe(0);
	});

	it("queues without dispatching while the agent is busy", async () => {
		const { controller, sendFollowUp, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("later"));
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(1);
	});

	it("pumps the next queued turn and mirrors the reply on agent end", async () => {
		const { controller, api, sendFollowUp, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("first", 1));
		await controller.onEvent(messageEvent("second", 2));
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(2);

		setIdle(true);
		await controller.onAgentEnd([{ role: "assistant", content: "done" }]);

		// reply mirrored to Telegram
		expect(api.sent.at(-1)?.rich_message).toEqual({
			markdown: "done",
			skip_entity_detection: true,
		});
		// and the next queued turn released
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("first");
		expect(controller.pendingCount()).toBe(1);
	});

	it("pumps the queue but delivers nothing for a run that is not the owner's", async () => {
		// Mixed mode: a manager moderation turn shares this session. Its text answers
		// the interlocutor, so it must never reach the owner's chat — but an owner
		// message queued behind it still has to be released once the turn ends.
		const { controller, api, sendFollowUp, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("are you there?", 1));
		setIdle(true);

		await controller.onAgentEnd(
			[{ role: "assistant", content: "a reply to the interlocutor" }],
			false,
		);

		expect(api.sent.some((m) => m.rich_message?.markdown)).toBe(false);
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("are you there?");
	});

	it("delivers each assistant message, so an answer followed by a tool call is not lost", async () => {
		// Regression: the model researched something, ANSWERED, then closed the browser
		// and added "done, browser closed". agent_end mirrored only the LAST assistant
		// text, so Telegram got the trailing line and the answer itself vanished.
		const { controller, api } = setup();
		await controller.deliverAssistant(
			"id Software is not closing: 136 layoffs…",
		);
		await controller.deliverAssistant("Done, browser closed.");
		// Nothing extra at the end of the run: the fallback is off once we mirrored.
		await controller.onAgentEnd(
			[{ role: "assistant", content: "Done, browser closed." }],
			false,
		);
		const sent = api.sent.map((m) => m.rich_message?.markdown);
		expect(sent).toEqual([
			"id Software is not closing: 136 layoffs…",
			"Done, browser closed.",
		]);
	});

	it("does not send when the final message is not an assistant reply", async () => {
		const { controller, api } = setup();
		await controller.onAgentEnd([{ role: "user", content: "ignored" }]);
		expect(api.sent).toHaveLength(0);
	});

	it("edits a still-queued turn instead of enqueuing a duplicate", async () => {
		const { controller, setIdle } = setup();
		setIdle(false);
		await controller.onEvent(messageEvent("original", 5));
		await controller.onEvent(editedEvent("edited", 5));
		expect(controller.pendingCount()).toBe(1);
	});

	it("skips a trailing empty assistant message when mirroring the reply", async () => {
		const { controller, api } = setup();
		await controller.onAgentEnd([
			{ role: "assistant", content: "the answer" },
			{ role: "assistant", content: "" },
		]);
		expect(api.sent.at(-1)?.rich_message).toEqual({
			markdown: "the answer",
			skip_entity_detection: true,
		});
	});

	it("delivers a downloaded image as content parts alongside the turn text", async () => {
		const loadImages = vi.fn(async () => [
			{ data: "BASE64", mimeType: "image/jpeg" },
		]);
		const { controller, sendFollowUp } = setup({ loadImages });
		await controller.onEvent(messageEvent("what is this?"));
		expect(loadImages).toHaveBeenCalledTimes(1);
		const content = sendFollowUp.mock.calls[0][0];
		expect(Array.isArray(content)).toBe(true);
		expect(content).toEqual([
			{ type: "image", data: "BASE64", mimeType: "image/jpeg" },
			{ type: "text", text: expect.stringContaining("what is this?") },
		]);
	});

	it("sends plain text (not an array) when there are no images", async () => {
		const { controller, sendFollowUp } = setup({
			loadImages: async () => [],
		});
		await controller.onEvent(messageEvent("just text"));
		expect(typeof sendFollowUp.mock.calls[0][0]).toBe("string");
	});

	it("reports saved file paths and attachment errors in the prompt turn", async () => {
		const saveAttachments = vi.fn(async () => ({
			savedFiles: [
				{ path: "/work/report.pdf", kind: "document", size: "1.2 MB" },
			],
			errors: ["huge.zip: too large"],
		}));
		const { controller, sendFollowUp } = setup({ saveAttachments });
		await controller.onEvent(messageEvent("see attached"));
		expect(saveAttachments).toHaveBeenCalledTimes(1);
		const content = sendFollowUp.mock.calls[0][0] as string;
		expect(content).toContain("[saved files: /work/report.pdf (1.2 MB)]");
		expect(content).toContain("[attachment errors: huge.zip: too large]");
	});

	it("sendFile routes to the uploadFile port", async () => {
		const uploadFile = vi.fn(async () => {});
		const { controller } = setup({ uploadFile });
		await controller.sendFile({ path: "/tmp/a.pdf", caption: "here" });
		expect(uploadFile).toHaveBeenCalledWith({
			path: "/tmp/a.pdf",
			caption: "here",
		});
	});

	it("sendFile throws when no upload port is wired", async () => {
		const { controller } = setup();
		await expect(controller.sendFile({ path: "/tmp/a.pdf" })).rejects.toThrow(
			/not available/,
		);
	});

	it("broadcasts a typing action to the bound chat", async () => {
		const { controller, api } = setup();
		await controller.sendTyping();
		expect(api.actions).toEqual([{ chat_id: ALLOWED, action: "typing" }]);
	});

	it("intercepts /clear as a control command instead of a prompt", async () => {
		const onClear = vi.fn(async () => {});
		const { controller, sendFollowUp } = setup({ onClear });
		const handled = await controller.onEvent(messageEvent("/clear"));
		expect(handled).toBe(true);
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(0);
	});

	it("intercepts /start and shows the privacy/terms reminder, without prompting", async () => {
		const { controller, api, sendFollowUp } = setup();
		const handled = await controller.onEvent(messageEvent("/start"));
		expect(handled).toBe(true);
		expect(sendFollowUp).not.toHaveBeenCalled();
		const markdown = api.sent.at(-1)?.rich_message.markdown ?? "";
		expect(markdown).toContain("Privacy & terms");
		expect(markdown).toContain("telegram.org/tos/bot-developers");
	});

	it("forwards an unknown command (e.g. /foobar) to the agent as a prompt", async () => {
		const onClear = vi.fn(async () => {});
		const { controller, sendFollowUp } = setup({ onClear });
		await controller.onEvent(messageEvent("/foobar"));
		expect(onClear).not.toHaveBeenCalled();
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
	});

	it("intercepts /esc (and /cancel) as an abort control command", async () => {
		const onAbort = vi.fn(async () => {});
		const { controller, sendFollowUp } = setup({ onAbort });
		expect(await controller.onEvent(messageEvent("/esc"))).toBe(true);
		expect(await controller.onEvent(messageEvent("/cancel", 2))).toBe(true);
		expect(onAbort).toHaveBeenCalledTimes(2);
		expect(sendFollowUp).not.toHaveBeenCalled();
	});

	it("answers /help with the command list, without prompting the agent", async () => {
		const { controller, api, sendFollowUp } = setup();
		const handled = await controller.onEvent(messageEvent("/help"));
		expect(handled).toBe(true);
		expect(sendFollowUp).not.toHaveBeenCalled();
		const markdown = api.sent.at(-1)?.rich_message.markdown ?? "";
		expect(markdown).toContain("/esc");
		expect(markdown).toContain("/clear");
	});

	it("sends a collapsible tool-activity block to the bound chat", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity({
			toolName: "bash",
			args: { command: "ls" },
		});
		const html = api.sent.at(-1)?.rich_message.html ?? "";
		expect(html).toContain("<details><summary>");
		expect(html).toContain("<code>bash</code>");
	});

	it("mirrors a terminal prompt to the chat with an origin marker", async () => {
		const { controller, api } = setup();
		await controller.mirrorTerminalInput("what is 2+2?");
		const markdown = api.sent.at(-1)?.rich_message.markdown ?? "";
		expect(markdown).toContain("from Pi terminal");
		expect(markdown).toContain("what is 2+2?");
	});

	it("skips mirroring an empty terminal prompt", async () => {
		const { controller, api } = setup();
		await controller.mirrorTerminalInput("   ");
		expect(api.sent).toHaveLength(0);
	});

	it("streams an animated draft with a stable non-zero id, cleared on end", async () => {
		const { controller, api } = setup();
		await controller.streamDraft("partial"); // no active draft yet → ignored
		expect(api.drafts).toHaveLength(0);

		controller.beginDraft();
		await controller.streamDraft("hel");
		await controller.streamDraft("hello");
		expect(api.drafts).toHaveLength(2);
		expect(api.drafts[0].draft_id).toBeGreaterThan(0);
		// Same message → same draft_id so Telegram animates in place.
		expect(api.drafts[0].draft_id).toBe(api.drafts[1].draft_id);
		expect(api.drafts[1].rich_message.markdown).toBe("hello");

		controller.endDraft();
		await controller.streamDraft("after end"); // no active draft → ignored
		expect(api.drafts).toHaveLength(2);
	});

	it("animates the thinking placeholder into the streaming text on ONE draft", async () => {
		const { controller, api } = setup();
		// The placeholder opens the draft itself — no beginDraft() beforehand.
		await controller.streamThinking(thinking("bash — npm test"));
		expect(api.drafts).toHaveLength(1);
		expect(api.drafts[0].rich_message.html).toBe(
			"<tg-thinking>bash — npm test</tg-thinking>",
		);

		// The reply starts: beginDraft must REUSE the open id, or the text would
		// arrive as a second draft and read as a flicker.
		controller.beginDraft();
		await controller.streamDraft("done");
		expect(api.drafts).toHaveLength(2);
		expect(api.drafts[1].draft_id).toBe(api.drafts[0].draft_id);
		expect(api.drafts[1].rich_message.markdown).toBe("done");
	});

	it("erases the placeholder on an aborted turn instead of letting it expire", async () => {
		const { controller, api } = setup();
		await controller.streamThinking(thinking("Thinking…"));
		const draftId = api.drafts[0].draft_id;

		await controller.clearDraft();
		expect(api.drafts).toHaveLength(2);
		expect(api.drafts[1].draft_id).toBe(draftId);
		expect(api.drafts[1].rich_message.html).toBe("");

		// The draft is closed: a late refresh cannot resurrect it.
		await controller.streamDraft("late");
		expect(api.drafts).toHaveLength(2);
	});

	it("escapes text in the placeholder and ignores empty markup", async () => {
		const { controller, api } = setup();
		await controller.streamThinking(RichHtml.raw("  "));
		expect(api.drafts).toHaveLength(0);

		await controller.streamThinking(thinking('grep — <b>&"x"'));
		expect(api.drafts[0].rich_message.html).toBe(
			'<tg-thinking>grep — &lt;b&gt;&amp;"x"</tg-thinking>',
		);
	});

	it("completes a tool card in place instead of posting a second message", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity(
			{ toolName: "bash", args: { command: "npm test" } },
			"call-1",
		);
		expect(api.sent).toHaveLength(1);
		const cardId = api.sent[0].rich_message ? 1000 : 0; // first id handed out
		expect(api.sent[0].rich_message.html).not.toContain("✅");

		await controller.completeToolActivity("call-1", "611 passed", false);
		// The card was edited, not duplicated.
		expect(api.sent).toHaveLength(1);
		expect(api.edits).toHaveLength(1);
		expect(api.edits[0].message_id).toBe(cardId);
		expect(api.edits[0].rich_message.html).toContain("✅");
		expect(api.edits[0].rich_message.html).toContain("611 passed");
		// The arguments survive the edit: the end event does not carry them.
		expect(api.edits[0].rich_message.html).toContain("npm test");
	});

	it("marks a failed call with a cross and folds its error in", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity(
			{ toolName: "bash", args: "exit 1" },
			"c",
		);
		await controller.completeToolActivity("c", "boom", true);
		expect(api.edits[0].rich_message.html).toContain("❌");
		expect(api.edits[0].rich_message.html).toContain("boom");
	});

	it("ignores a result for a call it has no card for", async () => {
		const { controller, api } = setup();
		await controller.completeToolActivity("never-sent", "x", false);
		expect(api.edits).toHaveLength(0);
	});

	it("completes each card only once", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity({ toolName: "ls" }, "c");
		await controller.completeToolActivity("c", "ok", false);
		await controller.completeToolActivity("c", "ok", false);
		expect(api.edits).toHaveLength(1);
	});

	it("closes cards left open by an aborted turn as cancelled", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity(
			{ toolName: "bash", args: "sleep 60" },
			"a",
		);
		await controller.sendToolActivity({ toolName: "read", args: "f.ts" }, "b");
		await controller.completeToolActivity("b", "contents", false);

		// /esc: the turn ends and "a" never returns.
		await controller.cancelOpenToolCards();
		expect(api.edits).toHaveLength(2);
		expect(api.edits[1].rich_message.html).toContain("⏹️");
		expect(api.edits[1].rich_message.html).toContain("sleep 60");

		// Nothing is left to cancel a second time.
		await controller.cancelOpenToolCards();
		expect(api.edits).toHaveLength(2);
	});

	it("survives an edit the API refuses — the running card simply stands", async () => {
		const { controller, api } = setup();
		await controller.sendToolActivity({ toolName: "ls" }, "c");
		api.failEdit = true;
		await expect(
			controller.completeToolActivity("c", "ok", false),
		).resolves.toBeUndefined();
		expect(api.edits).toHaveLength(0);
	});

	it("uses a fresh draft id for the next message", async () => {
		const { controller, api } = setup();
		controller.beginDraft();
		await controller.streamDraft("a");
		const first = api.drafts[0].draft_id;
		controller.endDraft();
		controller.beginDraft();
		await controller.streamDraft("b");
		expect(api.drafts[1].draft_id).not.toBe(first);
	});

	it("arms and clears the abort handler around a turn", async () => {
		const { controller, abort } = setup();
		const stop = vi.fn();
		controller.onAgentStart(stop);
		expect(abort.isArmed()).toBe(true);
		await controller.onAgentEnd([]);
		expect(abort.isArmed()).toBe(false);
	});
});

/** One message of a Telegram album: a photo, a shared media_group_id, caption on #1. */
function albumEvent(
	messageId: number,
	groupId: string,
	caption?: string,
): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		message: {
			message_id: messageId,
			date: 0,
			chat: { id: ALLOWED, type: "private", first_name: "A" },
			from: { id: ALLOWED, is_bot: false, first_name: "Ada" },
			media_group_id: groupId,
			caption,
			photo: [
				{
					file_id: `p${messageId}`,
					file_unique_id: `u${messageId}`,
					width: 10,
					height: 10,
				},
			],
		},
	} as Update);
}

describe("ConnectController albums", () => {
	function albumSetup() {
		const timers: (() => void)[] = [];
		let counter = 0;
		const base = setup({
			// Telegram delivers an album as separate messages; each carries one photo.
			loadImages: async (message) => [
				{ data: `img-${message.message_id}`, mimeType: "image/jpeg" },
			],
			setTimer: (fn) => {
				timers.push(fn);
				return counter++;
			},
			clearTimer: (handle) => {
				timers[handle as number] = () => {};
			},
		});
		return { ...base, flush: () => timers.at(-1)?.() };
	}

	it("collects an album into ONE turn: every photo, the caption once", async () => {
		// Regression: five photos became five turns — the model answering each picture
		// alone, four of them without the words that came with the first.
		const { controller, sendFollowUp, flush } = albumSetup();
		await controller.onEvent(albumEvent(1, "g1", "what do you make of these?"));
		await controller.onEvent(albumEvent(2, "g1"));
		await controller.onEvent(albumEvent(3, "g1"));
		// Held while the group is still growing.
		expect(sendFollowUp).not.toHaveBeenCalled();
		expect(controller.pendingCount()).toBe(1);

		flush();
		await Promise.resolve();

		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		const content = sendFollowUp.mock.calls[0][0] as Array<{
			type: string;
			data?: string;
			text?: string;
		}>;
		expect(content.filter((part) => part.type === "image")).toHaveLength(3);
		const text = content.find((part) => part.type === "text")?.text ?? "";
		expect(text).toContain("what do you make of these?");
	});

	it("does not delay a lone photo behind the album window", async () => {
		const { controller, sendFollowUp } = albumSetup();
		await controller.onEvent(messageEvent("just a question", 9));
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
	});
});

/** A message the owner FORWARDED into the bot DM (origin set, own body text). */
function forwardEvent(messageId: number, text: string): TelegramEvent {
	return classifyUpdate({
		update_id: messageId,
		message: {
			message_id: messageId,
			date: 0,
			chat: { id: ALLOWED, type: "private", first_name: "A" },
			from: { id: ALLOWED, is_bot: false, first_name: "Ada" },
			forward_origin: {
				type: "hidden_user",
				date: 0,
				sender_user_name: "Someone",
			},
			text,
		},
	} as Update);
}

describe("ConnectController forwards", () => {
	function forwardSetup(overrides: Partial<ConnectControllerDeps> = {}) {
		const timers: (() => void)[] = [];
		let counter = 0;
		let now = 0;
		const base = setup({
			forwards: { maxChars: 12, maxMessages: 2, groupWindowMs: 1000 },
			clock: { now: () => now },
			setTimer: (fn) => {
				timers.push(fn);
				return counter++;
			},
			clearTimer: (handle) => {
				timers[handle as number] = () => {};
			},
			...overrides,
		});
		return {
			...base,
			flush: () => timers.at(-1)?.(),
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	it("folds a batch of forwards into ONE turn, keeping every body", async () => {
		// Forwarding three posts sends three messages: as separate turns the model
		// would answer each one alone, which is not what forwarding them meant.
		const { controller, sendFollowUp, flush, advance } = forwardSetup({
			forwards: { maxChars: 100, maxMessages: 5, groupWindowMs: 1000 },
		});
		await controller.onEvent(forwardEvent(1, "first"));
		advance(50);
		await controller.onEvent(forwardEvent(2, "second"));
		advance(50);
		await controller.onEvent(forwardEvent(3, "third"));
		expect(sendFollowUp).not.toHaveBeenCalled();

		flush();
		await Promise.resolve();

		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		const text = String(sendFollowUp.mock.calls[0][0]);
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(text).toContain("third");
	});

	it("caps one forwarded body and says how much was not read", async () => {
		const { controller, sendFollowUp, flush } = forwardSetup();
		await controller.onEvent(forwardEvent(1, "0123456789abcdefgh"));
		flush();
		await Promise.resolve();
		const text = String(sendFollowUp.mock.calls[0][0]);
		expect(text).toContain("0123456789ab…[+6 chars not read]");
	});

	it("stops reading past the batch limit, noting it once", async () => {
		const { controller, sendFollowUp, flush } = forwardSetup();
		await controller.onEvent(forwardEvent(1, "one"));
		await controller.onEvent(forwardEvent(2, "two"));
		await controller.onEvent(forwardEvent(3, "three"));
		await controller.onEvent(forwardEvent(4, "four"));
		flush();
		await Promise.resolve();

		const text = String(sendFollowUp.mock.calls[0][0]);
		expect(text).toContain("one");
		expect(text).toContain("two");
		expect(text).not.toContain("three");
		expect(text).not.toContain("four");
		expect(text.match(/forward limit/g)).toHaveLength(1);
	});

	it("a message you typed yourself is not folded into the batch", async () => {
		const { controller, sendFollowUp, flush } = forwardSetup();
		await controller.onEvent(forwardEvent(1, "look at this"));
		await controller.onEvent(messageEvent("what do you think?", 2));
		flush();
		await Promise.resolve();

		// Two turns, not one: your own words are a message, not part of what you pasted.
		// The batch goes first (it arrived first), your question stays queued behind it.
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(String(sendFollowUp.mock.calls[0][0])).not.toContain(
			"what do you think?",
		);
		expect(controller.pendingCount()).toBe(1);
	});
});

// The owner's DM is split into topics, and they can type outside the personal one
// (the "All" view, the plain chat). The answer still goes to the personal topic:
// the message itself is forwarded there by the topic router (see acceptAsPersonal),
// so the controller has no cross-topic trickery to do. Quoting the far message was
// tried in its place and removed — the clients did not agree on what it meant.
describe("ConnectController: a message typed outside the personal topic", () => {
	const PERSONAL = 5;
	/** A topic that is not the personal one (a topic the owner made themselves). */
	const FOREIGN = 9;

	function threadEvent(
		messageId: number,
		threadId?: number,
		text = "hi",
	): TelegramEvent {
		return classifyUpdate({
			update_id: messageId,
			message: {
				message_id: messageId,
				date: 0,
				chat: { id: ALLOWED, type: "private", first_name: "A" },
				from: { id: ALLOWED, is_bot: false, first_name: "Ada" },
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
				text,
			},
		} as Update);
	}

	it.each([
		["typed in another topic", FOREIGN],
		["typed in the personal topic", PERSONAL],
		["typed with no topic at all", undefined],
	])("answers in the personal topic, plain, for a message %s", async (_name, thread) => {
		const { controller, api } = setup({ chatThread: () => PERSONAL });
		await controller.onEvent(threadEvent(11, thread));
		await controller.deliverAssistant("answer");

		expect(api.sent).toHaveLength(1);
		expect(api.sent[0].message_thread_id).toBe(PERSONAL);
		expect(api.sent[0]).not.toHaveProperty("reply_parameters");
	});

	it("hands over the turn's messages when the bot speaks, not when the turn starts", async () => {
		// The copy of a stray message is made from this hook. It must fire with the
		// bot's FIRST word, not when the prompt reaches the agent: a copy that lands
		// while the model is still thinking sits alone in the topic for seconds.
		const onTurnVisible = vi.fn(async () => {});
		const { controller, setIdle } = setup({
			chatThread: () => PERSONAL,
			onTurnVisible,
		});
		setIdle(false);
		await controller.onEvent(threadEvent(11, FOREIGN));
		await controller.onEvent(threadEvent(12, FOREIGN));

		setIdle(true);
		await controller.dispatch();
		// The prompt is with the agent, which is still silent — nothing copied yet.
		expect(onTurnVisible).not.toHaveBeenCalled();

		controller.beginDraft();
		await controller.streamDraft("thinking…");
		expect(onTurnVisible).toHaveBeenCalledExactlyOnceWith([11]);

		// The answer that follows is the same turn: it does not copy the prompt again.
		await controller.deliverAssistant("answer");
		expect(onTurnVisible).toHaveBeenCalledTimes(1);
	});

	it("hands them over with the answer when the model never streamed a draft", async () => {
		const onTurnVisible = vi.fn(async () => {});
		const { controller } = setup({
			chatThread: () => PERSONAL,
			onTurnVisible,
		});
		await controller.onEvent(threadEvent(11, FOREIGN));
		await controller.deliverAssistant("answer");

		expect(onTurnVisible).toHaveBeenCalledExactlyOnceWith([11]);
	});
});
