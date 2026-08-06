import { describe, expect, it } from "vitest";
import {
	createMemoryTools,
	MEMORY_TOOL_NAMES,
	MemoryLedger,
	type MemoryToolContext,
} from "../../../src/modes/manager/memory-tools";
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
	};
	const tools = new Map(
		createMemoryTools(context).map((tool) => [tool.name, tool]),
	);
	return { tools, ledger, memory };
}

const text = (result: unknown): string =>
	(result as { content: { text: string }[] }).content
		.map((c) => c.text)
		.join("");

describe("the memory verbs", () => {
	it("are listed in a fixed order", () => {
		// Tool schemas are rendered into the head of the prompt, so the same tools in a
		// different order are different bytes — a cache miss on the whole prompt.
		expect(MEMORY_TOOL_NAMES).toEqual([
			"manager_remember",
			"manager_recall",
			"manager_revise",
			"manager_forget",
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
		const { tools, memory } = harness();
		await memory?.remember({ text: "works at a bank", tags: ["fact"] });
		const result = await tools.get("manager_remember")?.execute("t1", {
			facts: [{ text: "works at a bank in town", subject: "interlocutor" }],
		});
		// The collision arrives attached to the write that caused it, with the id needed
		// to fix it — where it used to take a whole extra inference during a pass.
		expect(text(result)).toContain("close to what you already remember");
		expect(text(result)).toContain("works at a bank");
		expect(text(result)).toContain("manager_revise");
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
		const { tools, memory, ledger } = harness();
		await memory?.remember({ text: "prefers mornings", tags: ["fact"] });
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
});

describe("manager_revise", () => {
	it("supersedes a fact and says the old one is not erased", async () => {
		const { tools, memory } = harness();
		await memory?.remember({ text: "works at a bank", tags: ["fact"] });
		const result = await tools
			.get("manager_revise")
			?.execute("t1", { id: 0, text: "freelances" });
		expect(memory?.texts()).toEqual(["freelances"]);
		expect(text(result)).toContain("closed, not erased");
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
		const { tools, memory, ledger } = harness();
		await memory?.remember({ text: "hates coffee", tags: ["fact"] });
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

describe("manager_done", () => {
	it("is the only thing that ends a pass", async () => {
		const { tools, ledger } = harness();
		expect(ledger.isFinished()).toBe(false);
		await tools.get("manager_done")?.execute("t1", { summary: "all current" });
		expect(ledger.isFinished()).toBe(true);
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
});
