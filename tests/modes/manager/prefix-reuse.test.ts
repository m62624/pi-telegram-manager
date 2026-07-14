import type { Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import {
	ManagerController,
	type ManagerControllerDeps,
} from "../../../src/modes/manager/controller";
import { createBusinessStore } from "../../../src/storage/business-store";
import { createChatStore } from "../../../src/storage/chat-store";
import { createConsolidationQueue } from "../../../src/storage/consolidation-queue";
import { createContactStore } from "../../../src/storage/contact-store";
import { createTelegramPaths } from "../../../src/storage/paths";
import { createSentRegistry } from "../../../src/storage/sent-registry";
import { FakeFs } from "../../helpers/fake-fs";
import { PrefixCache, serializePrompt } from "../../helpers/prefix-cache";

/**
 * How much of the prompt a backend has to read again, measured on the real context builder.
 *
 * The manager rebuilds the model's context from scratch before every call to the model.
 * What that costs is decided entirely by how many of its LEADING bytes are the same as
 * last time — see `tests/helpers/prefix-cache.ts`.
 *
 * These assertions are in characters, not percentages, and that is deliberate. The
 * constant part of this context is ~24 KB of rules, which drowns any percentage: the
 * builder scores 96% reuse whatever we do to the kilobyte that follows, and 96% of
 * nothing is nothing. Characters re-read are what a prefill actually charges for.
 */

const OWNER_ID = 999;
const CONN = "conn-1";

/** ~24 KB of rules, the size of the real thing (manager.md + manager-common.md). */
const RULES = `MANAGER RULES\n${"rule line, long enough to matter.\n".repeat(600)}`;

/** A message of a length people actually write. */
const BODY =
	"so about that thing we discussed, could you tell me how it went and whether it is worth doing again";

function interlocutorMsg(
	text: string,
	chatId: number,
	fromId: number,
	messageId: number,
): Message {
	return {
		message_id: messageId,
		date: 0,
		chat: { id: chatId, type: "private", first_name: "Someone" },
		from: { id: fromId, is_bot: false, first_name: "Someone" },
		text,
	} as Message;
}

async function setup() {
	const fs = new FakeFs();
	const paths = createTelegramPaths("/agent");
	const clock = new ManualClock(0);
	const businessStore = createBusinessStore(fs, paths.businessPath);
	await businessStore.upsert({
		id: CONN,
		userId: String(OWNER_ID),
		isEnabled: true,
		connectedAt: 0,
		updatedAt: 0,
	});
	let idle = true;
	const deps: ManagerControllerDeps = {
		instructions: {
			base: RULES,
			firstMessage: "FIRST CONTACT — introduce yourself.",
			reopen: "WELCOME BACK — it has been a while.",
		},
		labeler: "LLM agent:",
		ownerName: "Mansur",
		mentionWords: [],
		rememberMessages: 20,
		maxCharsPerMessage: 4000,
		maxContextChars: 40000,
		continueWindowMs: 90_000,
		ownerReplyWindowMs: 300_000,
		factsLimit: 20,
		factConsolidationQuietMs: 1_800_000,
		verifyLimit: 8,
		liveFreshnessMs: 120_000,
		reopenAfterMs: 86_400_000,
		reviseThreshold: 2,
		strictReplyGuard: true,
		maxBytes: 52_428_800,
		media: { images: true, documents: false },
		clock,
		chatStore: createChatStore(fs, paths),
		contactStore: createContactStore(fs, paths),
		consolidationQueue: createConsolidationQueue(
			fs,
			paths.consolidationQueuePath,
		),
		sentRegistry: createSentRegistry(fs, paths.sentRegistryPath),
		businessStore,
		isIdle: () => idle,
		triggerAgent: vi.fn(async () => {}),
		sendReply: vi.fn(async () => [1]),
		typing: vi.fn(async () => {}),
	};
	const controller = new ManagerController(deps);
	return {
		controller,
		clock,
		setIdle: (v: boolean) => {
			idle = v;
		},
	};
}

/** Promote a chat and hand the model its context, as the runtime does. */
async function readContext(
	env: Awaited<ReturnType<typeof setup>>,
): Promise<string> {
	return serializePrompt(await env.controller.buildContextForActive());
}

/** A message arrives, the owner's window lapses, the chat is promoted. */
async function arrive(
	env: Awaited<ReturnType<typeof setup>>,
	chatId: number,
	fromId: number,
	messageId: number,
	text: string,
): Promise<void> {
	await env.controller.onBusinessMessage({
		connectionId: CONN,
		chatId: String(chatId),
		fromId,
		message: interlocutorMsg(text, chatId, fromId, messageId),
	});
	env.clock.advance(300_001);
	await env.controller.onTick();
}

describe("prompt prefix reuse", () => {
	it("re-reads only the tail when a chat carries on", async () => {
		// The common case, and the one that must stay cheap: the same person, one more
		// message, one more reply. Everything above the newest message is what the model
		// already read last turn, and it must still be there, byte for byte.
		const env = await setup();
		const cache = new PrefixCache();
		const reread: number[] = [];
		let messageId = 1;

		for (let round = 0; round < 14; round += 1) {
			await arrive(env, 42, 5, messageId++, `${BODY} (${round})`);
			reread.push(cache.serve(await readContext(env)).reread);
			env.controller.decisionSink().record({
				kind: "reply",
				text: `answer number ${round}, at some length`,
			});
			await env.controller.onAgentEnd();
		}

		// The first turn reads everything (nothing is cached yet); after that, a turn adds
		// one message and one reply, so a turn should re-read roughly that much — a few
		// hundred characters — and never the transcript above it.
		const steady = reread.slice(1);
		const worst = Math.max(...steady);
		console.log(
			`\n  same chat, 13 turns: worst re-read ${worst} chars, mean ${Math.round(steady.reduce((a, b) => a + b, 0) / steady.length)}\n`,
		);
		// Measured today: worst 2478, mean 1344 — the transcript of short messages is a
		// kilobyte, so even re-reading all of it is cheap. The long-message case below is
		// where this same sliding costs real time.
		expect(worst).toBeLessThan(3_000);
	});

	it("keeps the whole transcript when the model loops on tools inside one turn", async () => {
		// `pi.on("context")` fires before EVERY call to the model, not once per turn. The
		// context it builds must be the SAME context on each step of a tool loop, or the
		// model is reading a conversation that moves under it — and every step re-prefills.
		const env = await setup();
		const cache = new PrefixCache();
		let messageId = 1;
		for (let round = 0; round < 6; round += 1) {
			await arrive(env, 42, 5, messageId++, `${BODY} (${round})`);
			cache.serve(await readContext(env));
			env.controller
				.decisionSink()
				.record({ kind: "reply", text: `answer ${round}` });
			await env.controller.onAgentEnd();
		}

		// A turn begins…
		await arrive(env, 42, 5, messageId++, `${BODY} (final)`);
		const first = cache.serve(await readContext(env));
		// …and while the model is working, the same person sends another line.
		await env.controller.onBusinessMessage({
			connectionId: CONN,
			chatId: "42",
			fromId: 5,
			message: interlocutorMsg("oh and one more thing", 42, 5, messageId++),
		});
		// The model calls a tool and reads its context again — mid-turn.
		const second = cache.serve(await readContext(env));

		console.log(
			`\n  mid-turn tool step: re-reads ${second.reread} chars (the step before it re-read ${first.reread})\n`,
		);
		// The turn's own context must not have moved: the new message belongs to the NEXT
		// turn (the draft is held and re-decided), and re-reading the transcript for it
		// costs a full prefill of everything the model had already read.
		// Measured today: 686 — the new message lands at the END of the transcript, so it
		// only costs itself and the tail. What must never happen is the transcript ABOVE
		// it moving, which would cost the whole conversation.
		expect(second.reread).toBeLessThan(1_500);
	});

	it("charges a learned fact for itself, not for the transcript behind it", async () => {
		// Facts are appended to the head message, ABOVE the transcript. Anything written
		// above the transcript that later changes makes the model read the transcript
		// again — so the question is not "is it in the head", it is "what does it cost".
		const env = await setup();
		const cache = new PrefixCache();
		let messageId = 1;
		for (let round = 0; round < 8; round += 1) {
			await arrive(env, 42, 5, messageId++, `${BODY} (${round})`);
			cache.serve(await readContext(env));
			env.controller
				.decisionSink()
				.record({ kind: "reply", text: `answer ${round}` });
			await env.controller.onAgentEnd();
		}

		// The model remembers something about this person, and the turn ends.
		await arrive(env, 42, 5, messageId++, `${BODY} (remembering)`);
		cache.serve(await readContext(env));
		env.controller.factSink().record([
			{
				text: "Works night shifts, so mornings are bad",
				subject: "interlocutor",
				kind: "profile",
			},
		]);
		env.controller.decisionSink().record({ kind: "reply", text: "noted" });
		await env.controller.onAgentEnd();

		// Next turn: the fact is now in the context.
		await arrive(env, 42, 5, messageId++, `${BODY} (after)`);
		const after = cache.serve(await readContext(env));
		console.log(
			`\n  turn after learning a fact: re-reads ${after.reread} chars\n`,
		);
		// It must cost the fact and the tail — not the whole conversation above it.
		expect(after.reread).toBeLessThan(3_000);
	});

	it("keeps the head byte-identical, whoever is talking and whatever it has learned", async () => {
		// The invariant the whole cost model rests on, asserted rather than hoped for: the
		// first message is the standing rules and nothing else, so it is the same bytes for
		// every chat and every turn. Put one per-chat or per-turn value back up there and
		// this fails — which is the point, because the price of that is the transcript.
		const env = await setup();
		await arrive(env, 42, 5, 1, `${BODY} from Alice`);
		const first = (await env.controller.buildContextForActive())?.[0].content;
		env.controller
			.factSink()
			.record([
				{ text: "Likes green tea", subject: "interlocutor", kind: "profile" },
			]);
		env.controller.decisionSink().record({ kind: "reply", text: "hi" });
		await env.controller.onAgentEnd();

		await arrive(env, 43, 6, 2, `${BODY} from Bob`);
		const second = (await env.controller.buildContextForActive())?.[0].content;
		expect(second).toBe(first);

		await arrive(env, 42, 5, 3, `${BODY} again`);
		const third = (await env.controller.buildContextForActive())?.[0].content;
		expect(third).toBe(first);
	});

	it("shares the rulebook between two chats, so a switch is not a fresh start", async () => {
		const env = await setup();
		const cache = new PrefixCache();
		await arrive(env, 42, 5, 1, `${BODY} from Alice`);
		const alice = cache.serve(await readContext(env));
		env.controller.decisionSink().record({ kind: "reply", text: "hi Alice" });
		await env.controller.onAgentEnd();

		await arrive(env, 43, 6, 2, `${BODY} from Bob`);
		const bob = cache.serve(await readContext(env));

		console.log(
			`\n  chat switch: re-reads ${bob.reread} chars of ${Math.round(alice.reread / 1000)}k (the rulebook is shared)\n`,
		);
		// The rules are ~24 KB and they are the same rules for everyone. A chat switch may
		// cost the other chat's transcript; it must never cost the rulebook again.
		expect(bob.reread).toBeLessThan(3_000);
	});
});

describe("prompt prefix reuse, when the transcript is the big part", () => {
	// The rulebook is 24 KB and constant. A transcript of short messages is a kilobyte,
	// which is why nothing above costs much. But `maxCharsPerMessage` is 4000 and
	// `maxContextChars` is 40000 — because people paste. When the transcript is the
	// bigger half of the prompt, anything written ABOVE it that changes is charged the
	// whole thing.
	const LONG = "a".repeat(1_800);

	it("measures what a long-transcript chat pays per turn", async () => {
		const env = await setup();
		const cache = new PrefixCache();
		const reread: number[] = [];
		let messageId = 1;
		for (let round = 0; round < 16; round += 1) {
			await arrive(env, 42, 5, messageId++, `${LONG} (${round})`);
			reread.push(cache.serve(await readContext(env)).reread);
			env.controller
				.decisionSink()
				.record({ kind: "reply", text: `answer ${round}` });
			await env.controller.onAgentEnd();
		}
		const steady = reread.slice(1);
		console.log(
			`\n  long transcript, 15 turns: worst re-read ${Math.max(...steady)} chars, mean ${Math.round(steady.reduce((a, b) => a + b, 0) / steady.length)}\n`,
		);
		expect(steady.length).toBe(15);
	});

	it("measures what a learned fact costs a long-transcript chat", async () => {
		const env = await setup();
		const cache = new PrefixCache();
		let messageId = 1;
		for (let round = 0; round < 10; round += 1) {
			await arrive(env, 42, 5, messageId++, `${LONG} (${round})`);
			cache.serve(await readContext(env));
			env.controller
				.decisionSink()
				.record({ kind: "reply", text: `answer ${round}` });
			await env.controller.onAgentEnd();
		}
		await arrive(env, 42, 5, messageId++, `${LONG} (remember)`);
		cache.serve(await readContext(env));
		env.controller.factSink().record([
			{
				text: "Works night shifts",
				subject: "interlocutor",
				kind: "profile",
			},
		]);
		env.controller.decisionSink().record({ kind: "reply", text: "noted" });
		await env.controller.onAgentEnd();

		await arrive(env, 42, 5, messageId++, `${LONG} (after)`);
		const after = cache.serve(await readContext(env));
		console.log(
			`\n  long transcript, turn after a fact: re-reads ${after.reread} chars\n`,
		);
		expect(after.reread).toBeGreaterThan(0);
	});
});
