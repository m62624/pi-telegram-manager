import { describe, expect, it } from "vitest";
import {
	createMemoryTools,
	MEMORY_TOOL_NAMES,
	MemoryLedger,
	type MemoryToolContext,
	stripRendering,
} from "../../../src/modes/manager/memory-tools";
import type {
	MemoryRecallQuery,
	MemoryRecallResult,
} from "../../../src/storage/memory";
import { FakeContactMemory } from "../../helpers/fake-memory";

/**
 * The memory verbs.
 *
 * The thing they all share, and the reason the consolidation loop can be cut off at
 * any point: every one of them writes on the spot. Nothing is buffered until a pass
 * "finishes", because a pass is pre-empted by any live message and the previous design
 * threw away a whole interrogation every time that happened.
 */

function harness(memory: FakeContactMemory | null = new FakeContactMemory()) {
	const ledger = new MemoryLedger();
	ledger.startTurn();
	const context: MemoryToolContext = {
		active: async () => memory,
		contactName: () => "Alice",
		ledger: () => ledger,
		now: () => 1_000,
		timezone: "UTC",
	};
	const tools = new Map(
		createMemoryTools(context).map((tool) => [tool.name, tool]),
	);
	/**
	 * Put a fact in the memory the way the tools do — under the contact's own subject.
	 *
	 * Not a convenience. The engine scopes its duplicate check to the entity a write
	 * names, so a fact seeded under no subject is invisible to a guarded write about
	 * Alice: the test would set up a collision that cannot happen and then pass on the
	 * absence of it.
	 */
	const seed = async (text: string, tags: string[] = ["fact"], at = 0) => {
		// `at` is when the memory LEARNED it, which is the axis a window reads — the
		// engine stamps that itself and `validFrom` does not move it.
		if (memory) memory.recordingAt = at;
		const written = await memory?.remember({ text, entity: "Alice", tags });
		if (memory) memory.recordingAt = null;
		return written;
	};
	return { tools, ledger, memory, seed };
}

const text = (result: unknown): string =>
	(result as { content: { text: string }[] }).content
		.map((c) => c.text)
		.join("");

/** Counts the searches a write performs, which must be none. */
class RecallCountingMemory extends FakeContactMemory {
	recalls = 0;

	override async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
		this.recalls += 1;
		return super.recall(query);
	}
}

describe("the memory verbs", () => {
	it("are listed in a fixed order", () => {
		// Tool schemas are rendered into the head of the prompt, so the same tools in a
		// different order are different bytes — a cache miss on the whole prompt.
		expect(MEMORY_TOOL_NAMES).toEqual([
			"manager_remember",
			"manager_recall",
			"manager_revise",
			"manager_forget",
			"manager_link",
			"manager_unlink",
			"manager_done",
		]);
	});

	it("say so, rather than failing silently, when there is no memory open", async () => {
		const { tools } = harness(null);
		const result = await tools.get("manager_recall")?.execute("t1", {});
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("no contact memory open");
		expect(text(result)).toContain(
			"Owner chats deliberately have no personal memory",
		);
	});
});

describe("manager_remember", () => {
	it("stores a fact and reports the id it can be revised by", async () => {
		const { tools, memory, ledger } = harness();
		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{ text: "lives in Almaty", subject: "interlocutor", kind: "identity" },
			],
		});
		expect(memory?.texts()).toEqual(["lives in Almaty"]);
		expect(text(result)).toContain("[f0]");
		expect(ledger.size()).toBe(1);
	});

	it("stores the sentence, not the way a recalled line was displayed", async () => {
		const { tools, memory } = harness();
		await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{
					text: "- [f7] Alice: takes evening classes (2026-08; active) #fact #preference",
					subject: "interlocutor",
					kind: "preference",
				},
			],
		});
		expect(memory?.texts()).toEqual(["takes evening classes"]);
	});

	it("keeps only what is about the person being talked to", async () => {
		const { tools, memory } = harness();
		await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{ text: "keeps this", subject: "interlocutor" },
				{ text: "owner detail", subject: "owner" },
				{ text: "third party", subject: "other" },
				{ text: "unknown tag", subject: "bogus" },
			],
		});
		// With one database per person, "whose file does this go in" stopped being
		// tidiness and became a security boundary: a fact about the OWNER filed here is a
		// fact about the owner surfacing in a stranger's conversation.
		expect(memory?.texts()).toEqual(["keeps this"]);
	});

	it("shows the model what a new fact may be contradicting", async () => {
		const { tools, memory, ledger, seed } = harness();
		await seed("works at a bank");
		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [{ text: "works at a bank in town", subject: "interlocutor" }],
		});
		// The guard catches the collision BEFORE the new fact exists, with the id
		// needed to revise it or explicitly keep both.
		expect(memory?.texts()).toEqual(["works at a bank"]);
		expect(text(result)).toContain("Not stored yet");
		expect(text(result)).toContain("works at a bank");
		expect(text(result)).toContain("manager_revise");
		expect(ledger.steps().at(-1)?.summary).toContain("stored 0 fact(s)");
	});

	it("stores a merely related fact instead of holding it for review", async () => {
		// The regression this whole change exists for. A recall was used as the
		// duplicate check, and a recall always returns its best candidate — so with an
		// embedder configured, EVERY new fact had a nearest neighbour and every write
		// was held. The shape of the case that caught it: a note that somebody knows a
		// series well, refused as a near-duplicate of a note that they want to play a
		// game without spoilers, on a fused rank of 0.02. They share a topic and not a
		// statement, and the memory must simply keep both.
		const { tools, memory, seed } = harness();
		await seed("wants to play a new game without spoilers", [
			"fact",
			"preference",
		]);

		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{
					text: "knows the lore of a long-running series well",
					subject: "interlocutor",
					kind: "context",
				},
			],
		});

		expect(memory?.texts()).toEqual([
			"wants to play a new game without spoilers",
			"knows the lore of a long-running series well",
		]);
		expect(text(result)).toContain("Stored [f1]");
		expect(text(result)).not.toContain("Not stored yet");
	});

	it("asks the memory to judge similarity instead of searching for it", async () => {
		// A recall answers "what is worth showing", which is a different question from
		// "does this already exist" and has no threshold under which it says nothing.
		// The tool must not ask the first question and read the answer as the second.
		const memory = new RecallCountingMemory();
		const { tools, seed } = harness(memory);
		await seed("works at a bank");

		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [{ text: "likes tea", subject: "interlocutor" }],
		});

		expect(memory.texts()).toEqual(["works at a bank", "likes tea"]);
		expect(text(result)).toContain("Stored [f1]");
		expect(memory.recalls).toBe(0);
	});

	it("skips an exact duplicate without creating another fact", async () => {
		const { tools, memory, seed } = harness();
		await seed("enjoys a particular hobby", ["fact", "preference"]);
		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{
					text: "Enjoys a particular hobby!",
					subject: "interlocutor",
					kind: "preference",
				},
			],
		});
		expect(memory?.texts()).toEqual(["enjoys a particular hobby"]);
		expect(text(result)).toContain("Already remembered [f0]");
	});

	it("writes a compatible close fact only after explicit confirmation", async () => {
		const { tools, memory, seed } = harness();
		await seed("plays guitar every evening", ["fact", "preference"]);
		const fact = {
			text: "plays guitar every evening with friends",
			subject: "interlocutor",
			kind: "preference",
		};
		const blocked = await tools
			.get("manager_remember")
			?.execute("t1", { facts: [fact] });
		expect(memory?.texts()).toEqual(["plays guitar every evening"]);
		expect(text(blocked)).toContain("confirm_similar=true");

		const confirmed = await tools
			.get("manager_remember")
			?.execute("t2", { confirm_similar: true, facts: [fact] });
		expect(memory?.texts()).toEqual([
			"plays guitar every evening",
			"plays guitar every evening with friends",
		]);
		expect(text(confirmed)).toContain("Stored [f1]");
		// The candidate it just reviewed, named again with the id that takes the
		// decision back — the confirmed write is the only path that still reports it.
		expect(text(confirmed)).toContain("[f0]");
	});

	it("refuses an exact duplicate even when the model insists", async () => {
		// confirm_similar answers "both statements are true", which the same sentence
		// twice never is. Writing it again would cost a fact id and change nothing.
		const { tools, memory, seed } = harness();
		await seed("enjoys a particular hobby", ["fact", "preference"]);
		const result = await tools.get("manager_remember")?.execute("t1", {
			confirm_similar: true,
			facts: [
				{
					text: "Enjoys a particular hobby!",
					subject: "interlocutor",
					kind: "preference",
				},
			],
		});
		expect(memory?.texts()).toEqual(["enjoys a particular hobby"]);
		expect(text(result)).toContain("Already remembered [f0]");
	});

	it("stores nothing, and says why, when nothing was about them", async () => {
		const { tools, memory } = harness();
		const result = await tools
			.get("manager_remember")
			?.execute("t1", { facts: [{ text: "owner detail", subject: "owner" }] });
		expect(memory?.texts()).toEqual([]);
		expect(text(result)).toContain(
			"owner/other facts are deliberately discarded",
		);
		expect(text(result)).toContain(
			"In a contact chat, retry only with facts about the interlocutor",
		);
	});
});

describe("manager_recall", () => {
	it("returns the block, with the ids the other verbs take", async () => {
		const { tools, ledger, seed } = harness();
		await seed("prefers mornings");
		const result = await tools
			.get("manager_recall")
			?.execute("t1", { query: "prefers" });
		expect(text(result)).toContain("[f0]");
		expect(ledger.steps()[0].tool).toBe("manager_recall");
	});

	it("says plainly that a miss is a miss", async () => {
		const { tools } = harness();
		const result = await tools
			.get("manager_recall")
			?.execute("t1", { query: "anything" });
		// "Nothing matched" has to be unambiguous, or a model fills the gap by inferring
		// the answer from the conversation and reporting it as something it remembered.
		expect(text(result)).toContain("do not infer it");
	});

	it("blocks a recall-only loop after several different searches", async () => {
		const { tools, ledger } = harness();
		for (const query of ["first point", "second point", "third point"]) {
			await tools.get("manager_recall")?.execute("t1", { query });
		}

		const blocked = await tools
			.get("manager_recall")
			?.execute("t1", { query: "a rephrased point" });

		expect((blocked as { isError?: boolean }).isError).toBe(true);
		expect(text(blocked)).toContain(
			"Do not search again with a rephrased query",
		);
		expect(ledger.size()).toBe(3);
	});
});

describe("manager_recall over time", () => {
	// A day in the harness's zone (UTC), so the dates below are the instants they read as.
	const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

	it("answers about a period the transcript no longer holds", async () => {
		const { tools, seed } = harness();
		await seed(
			"agreed to ship on the 12th",
			["fact", "agreement"],
			day("2026-06-14"),
		);
		await seed("moved to a new flat", ["fact", "identity"], day("2026-08-02"));

		const june = await tools.get("manager_recall")?.execute("t1", {
			query: "what we agreed",
			after: "2026-06-01",
			before: "2026-07-01",
		});
		expect(text(june)).toContain("ship on the 12th");
		expect(text(june)).not.toContain("new flat");
	});

	it("asks for the period alone, and says the query did not rank it", async () => {
		// `range` is a source in the engine, not a filter: sent alongside a query or an
		// entity anchor it adds the period to whatever those matched, so the tool sends
		// it alone. That is a real difference in what comes back, and the model is told
		// rather than left to assume its words did the ranking.
		const asked: MemoryRecallQuery[] = [];
		class Watching extends FakeContactMemory {
			override async recall(
				query: MemoryRecallQuery,
			): Promise<MemoryRecallResult> {
				asked.push(query);
				return super.recall(query);
			}
		}
		const memory = new Watching();
		const { tools, seed } = harness(memory);
		await seed(
			"agreed to ship on the 12th",
			["fact", "agreement"],
			day("2026-06-14"),
		);

		const result = await tools.get("manager_recall")?.execute("t1", {
			query: "shipping",
			after: "2026-06-01",
			before: "2026-07-01",
		});
		expect(asked[0].range).toEqual([
			Date.parse("2026-06-01T00:00:00Z"),
			Date.parse("2026-07-01T00:00:00Z"),
		]);
		expect(asked[0].query).toBeUndefined();
		expect(asked[0].entities).toBeUndefined();
		expect(text(result)).toContain("newest first");
		expect(text(result)).toContain("ship on the 12th");
	});

	it("says the window is why it found nothing, not the memory", async () => {
		// An empty answer from a bounded search says nothing about what is stored, and a
		// model that reads it as "I know nothing about them" acts on that.
		const { tools, seed } = harness();
		await seed("moved to a new flat", ["fact", "identity"], day("2026-08-02"));
		const result = await tools.get("manager_recall")?.execute("t1", {
			query: "flat",
			after: "2026-01-01",
			before: "2026-02-01",
		});
		expect(text(result)).toContain("recorded 2026-01-01…2026-02-01");
		expect(text(result)).toContain("Search again without the dates");
	});

	it("refuses a date it cannot read instead of searching without it", async () => {
		const { tools, ledger } = harness();
		const result = await tools
			.get("manager_recall")
			?.execute("t1", { query: "anything", after: "last month" });
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("YYYY-MM-DD");
		expect(ledger.size()).toBe(0);
	});

	it("refuses a window that cannot contain anything", async () => {
		const { tools } = harness();
		const result = await tools
			.get("manager_recall")
			?.execute("t1", { after: "2026-08-01", before: "2026-07-01" });
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("window is empty");
	});

	it("counts two periods as two questions, not a repeated one", async () => {
		// The pass's repeat detector compares argument signatures. Without the window in
		// there, asking the same words about June and about August would look like the
		// model looping on one query.
		const { tools, ledger, seed } = harness();
		await seed(
			"agreed to ship on the 12th",
			["fact", "agreement"],
			day("2026-06-14"),
		);
		await tools
			.get("manager_recall")
			?.execute("t1", { query: "what we agreed", after: "2026-06-01" });
		await tools
			.get("manager_recall")
			?.execute("t2", { query: "what we agreed", after: "2026-08-01" });
		expect(ledger.repeatedLast()).toBe(false);
	});
});

describe("manager_revise", () => {
	it("supersedes a fact and says the old one is not erased", async () => {
		const { tools, memory, seed } = harness();
		await seed("works at a bank");
		const result = await tools
			.get("manager_revise")
			?.execute("t1", { id: 0, text: "freelances" });
		expect(memory?.texts()).toEqual(["freelances"]);
		expect(text(result)).toContain("closed, not erased");
	});

	it("stores the sentence when the model pastes the whole recalled line back", async () => {
		// What a pass actually did: it read `- [f0] Alice: … (2026-08; active) #fact
		// #context` and handed the correction back with the decoration still on it, so
		// the display string became part of the fact and would render twice next time.
		const { tools, memory, seed } = harness();
		await seed("works at a bank");
		await tools.get("manager_revise")?.execute("t1", {
			id: 0,
			text: "- [f0] Alice: freelances now (2026-08; active) #fact #context",
		});
		expect(memory?.texts()).toEqual(["freelances now"]);
	});

	it("keeps a parenthesis and a hashtag that belong to the sentence", async () => {
		const { tools, memory, seed } = harness();
		await seed("works at a bank");
		await tools
			.get("manager_revise")
			?.execute("t1", { id: 0, text: "works remotely (mostly) #teamgreen" });
		expect(memory?.texts()).toEqual(["works remotely (mostly) #teamgreen"]);
	});

	it("refuses an id that is not there, and says how to find one", async () => {
		const { tools, ledger } = harness();
		const result = await tools
			.get("manager_revise")
			?.execute("t1", { id: 99, text: "whatever" });
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("manager_recall");
		expect(ledger.size()).toBe(0);
	});
});

describe("manager_forget", () => {
	it("drops a fact and names what went", async () => {
		const { tools, memory, ledger, seed } = harness();
		await seed("hates coffee");
		const result = await tools
			.get("manager_forget")
			?.execute("t1", { id: 0, reason: "never said that" });
		expect(memory?.texts()).toEqual([]);
		expect(text(result)).toContain("hates coffee");
		// The owner's log is how a freely-forgetting model stays auditable.
		expect(ledger.steps()[0].summary).toContain("never said that");
	});

	it("refuses an id that is not there", async () => {
		const { tools } = harness();
		const result = await tools.get("manager_forget")?.execute("t1", { id: 7 });
		expect((result as { isError?: boolean }).isError).toBe(true);
	});
});

describe("manager_link / manager_unlink", () => {
	it("connects the contact to a topic by default", async () => {
		const { tools, memory, ledger } = harness();
		const result = await tools
			.get("manager_link")
			?.execute("t1", { dst: "chess", relation: "involved_in" });
		expect(memory?.links).toEqual(["Alice —involved_in→ chess"]);
		expect(text(result)).toContain("Alice —involved_in→ chess");
		expect(ledger.steps()[0].tool).toBe("manager_link");
	});

	it("chains topic to topic when src is another topic", async () => {
		const { tools, memory } = harness();
		await tools.get("manager_link")?.execute("t1", {
			src: "chess",
			dst: "board games",
			relation: "part_of",
		});
		expect(memory?.links).toEqual(["chess —part_of→ board games"]);
	});

	it("refuses an unknown relation", async () => {
		const { tools } = harness();
		const result = await tools
			.get("manager_link")
			?.execute("t1", { dst: "chess", relation: "bogus" });
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(text(result)).toContain("must be one of");
	});

	it("closes a link that exists", async () => {
		const { tools, memory } = harness();
		await tools
			.get("manager_link")
			?.execute("t1", { dst: "chess", relation: "involved_in" });
		const result = await tools
			.get("manager_unlink")
			?.execute("t2", { dst: "chess", relation: "involved_in" });
		expect(memory?.links).toEqual([]);
		expect(text(result)).toContain("Unlinked");
	});

	it("says plainly when there was nothing to unlink", async () => {
		const { tools } = harness();
		const result = await tools
			.get("manager_unlink")
			?.execute("t1", { dst: "chess", relation: "involved_in" });
		expect(text(result)).toContain("no");
		expect(text(result)).toContain("link to close");
	});
});

describe("topic-filed facts", () => {
	it("manager_remember files a fact under the topic entity, not the contact", async () => {
		const { tools, memory } = harness();
		await tools.get("manager_remember")?.execute("t1", {
			facts: [
				{
					text: "is a strategy game played on a checkered board",
					subject: "interlocutor",
					kind: "context",
					topic: "chess",
				},
			],
		});
		expect(memory?.facts[0]?.entity).toBe("chess");
	});

	it("manager_revise keeps a topic-filed fact under the same topic", async () => {
		const { tools, memory } = harness();
		await memory?.remember({
			text: "is a strategy game played on a checkered board",
			entity: "chess",
			tags: ["fact", "context"],
		});
		await tools.get("manager_revise")?.execute("t1", {
			id: 0,
			text: "is a two-player strategy game",
			topic: "chess",
		});
		const revised = memory?.facts.find((fact) =>
			fact.text.includes("two-player"),
		);
		expect(revised?.entity).toBe("chess");
	});
});

describe("stripRendering", () => {
	it("strips a leading entity prefix that does not match the one passed in", async () => {
		// A generic fallback for a line copied from a DIFFERENT entity's block than the
		// one this write names — only trips when the trailing decoration is still there.
		const cleaned = stripRendering(
			"chess: is a two-player strategy game (2026-08; active) #fact #context",
			"Alice",
		);
		expect(cleaned).toBe("is a two-player strategy game");
	});

	it("leaves an ordinary sentence starting with a capitalized word alone", async () => {
		const cleaned = stripRendering("Note: bring an umbrella tomorrow", "Alice");
		expect(cleaned).toBe("Note: bring an umbrella tomorrow");
	});
});

describe("manager_done", () => {
	it("is the only thing that ends a pass", async () => {
		const { tools, ledger } = harness();
		expect(ledger.isFinished()).toBe(false);
		await tools.get("manager_done")?.execute("t1", {});
		expect(ledger.isFinished()).toBe(true);
	});

	it("reports committed operations instead of trusting model prose", async () => {
		const { tools, seed } = harness();
		await seed("works at a bank");
		await tools.get("manager_remember")?.execute("t1", {
			facts: [{ text: "works at a bank in town", subject: "interlocutor" }],
		});

		const result = await tools.get("manager_done")?.execute("t1", {
			summary: "the new fact was added",
		});

		expect(text(result)).not.toContain("fact stored");
		expect(text(result)).toContain("1 fact not stored");
		expect(text(result)).not.toContain("the new fact was added");
	});

	it("reports a real write as stored", async () => {
		const { tools } = harness();
		await tools.get("manager_remember")?.execute("t1", {
			facts: [{ text: "likes tea", subject: "interlocutor" }],
		});

		const result = await tools.get("manager_done")?.execute("t1", {});
		expect(text(result)).toContain("1 fact stored");
	});
});

describe("MemoryLedger", () => {
	it("tells a repeat from a fresh call", () => {
		const ledger = new MemoryLedger();
		ledger.record({ tool: "manager_recall", argsKey: "a", summary: "a" });
		expect(ledger.repeatedLast()).toBe(false);
		ledger.record({ tool: "manager_recall", argsKey: "a", summary: "a" });
		expect(ledger.repeatedLast()).toBe(true);
		ledger.record({ tool: "manager_recall", argsKey: "b", summary: "b" });
		expect(ledger.repeatedLast()).toBe(false);
	});

	it("numbers its journal, so a directive can quote it back", () => {
		const ledger = new MemoryLedger();
		expect(ledger.digest()).toBe("");
		ledger.record({
			tool: "manager_recall",
			argsKey: "a",
			summary: "recalled a",
		});
		ledger.record({
			tool: "manager_forget",
			argsKey: "1",
			summary: "forgot [f1]",
		});
		expect(ledger.digest()).toBe("1. recalled a\n2. forgot [f1]");
	});

	it("keeps a compact context draft and resets inspection pressure after progress", () => {
		const ledger = new MemoryLedger();
		expect(ledger.contextDraft()).toContain("no memory tool has run");
		for (const argsKey of ["a", "b", "c"]) {
			ledger.record({
				tool: "manager_recall",
				argsKey,
				summary: "recalled a concrete point → 0 hit(s)",
			});
		}
		expect(ledger.recallCountSinceProgress()).toBe(3);
		expect(ledger.recallBlocked()).toBe(true);
		expect(ledger.contextDraft()).toContain("inspection is complete");

		ledger.record({
			tool: "manager_remember",
			argsKey: "new",
			summary: "remembered one useful fact",
		});
		expect(ledger.recallCountSinceProgress()).toBe(0);
		expect(ledger.recallBlocked()).toBe(false);
		expect(ledger.contextDraft()).toContain("0/3 recall checks");
	});
});
