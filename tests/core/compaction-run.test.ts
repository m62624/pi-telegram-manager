import { describe, expect, it, vi } from "vitest";
import { compactionFocus } from "../../src/core/compaction-focus";
import { conversationOnly } from "../../src/core/compaction-material";
import {
	type CompactionAuth,
	isRealSummary,
	runFocusedCompaction,
	summaryProse,
} from "../../src/core/compaction-run";

type Model = { id: string };
type Preparation = {
	firstKeptEntryId: string;
	tokensBefore: number;
	messagesToSummarize: unknown[];
};

const MODEL: Model = { id: "local-model" };

/** A history with the shape that breaks a summariser: two lines said, one huge tool dump. */
const MESSAGES: unknown[] = [
	{ role: "user", content: [{ type: "text", text: "port the parser" }] },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "reading the file" },
			{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
		],
	},
	{ role: "toolResult", content: [{ type: "text", text: "x".repeat(50_000) }] },
];

const PREPARATION: Preparation = {
	firstKeptEntryId: "entry-7",
	tokensBefore: 120_712,
	messagesToSummarize: MESSAGES,
};
const OK: CompactionAuth = { ok: true, apiKey: "local", headers: { x: "1" } };

/** What a real summary looks like: prose, written by the model. */
const RESULT = {
	summary:
		"The owner asked for the parser to be ported, and for the CLI flags to keep " +
		"their old names. Still open: the error messages.",
	firstKeptEntryId: "entry-7",
	tokensBefore: 120_712,
};

/**
 * What came back the day this guard was written: the model wrote nothing, and Pi appended
 * the file list it computes in code. Non-empty, and not a summary.
 */
const FILE_LIST_ONLY = {
	...RESULT,
	summary: "\n\n<read-files>\n/repo/src/a.ts\n/repo/src/b.ts\n</read-files>",
};

function setup(over: Partial<Parameters<typeof runFocusedCompaction>[0]> = {}) {
	const compact = vi.fn(async () => RESULT);
	const auth = vi.fn(async () => OK);
	const input = {
		thread: "personal" as const,
		model: MODEL,
		preparation: PREPARATION,
		auth,
		compact,
		conversationOnly,
		...over,
	};
	return { input, compact, auth };
}

describe("summaryProse", () => {
	it("does not count the file list Pi appends in code as something the model wrote", () => {
		expect(summaryProse(FILE_LIST_ONLY.summary)).toBe("");
		expect(isRealSummary(FILE_LIST_ONLY.summary)).toBe(false);
		expect(isRealSummary(RESULT.summary)).toBe(true);
	});

	it("keeps the model's prose when a file list follows it", () => {
		const summary = `${RESULT.summary}\n\n<read-files>\n/repo/a.ts\n</read-files>`;
		expect(summaryProse(summary)).toBe(RESULT.summary);
		expect(isRealSummary(summary)).toBe(true);
	});
});

describe("runFocusedCompaction", () => {
	it("fills the argument Pi's automatic compaction leaves empty", async () => {
		// This is the entire point: `compact()` takes `customInstructions`, and the path
		// that actually fires in a long session passes `undefined` for it.
		const { input, compact } = setup();
		const result = await runFocusedCompaction(input);
		expect(result).toEqual({ kind: "compaction", compaction: RESULT });
		expect(compact).toHaveBeenCalledTimes(1);
		expect(compact.mock.calls[0][0].customInstructions).toBe(
			compactionFocus("personal"),
		);
	});

	it("briefs each thread differently — they are not the same conversation", async () => {
		const { input: personal, compact: personalCompact } = setup({
			thread: "personal",
		});
		const { input: manager, compact: managerCompact } = setup({
			thread: "manager",
		});
		await runFocusedCompaction(personal);
		await runFocusedCompaction(manager);
		expect(personalCompact.mock.calls[0][0].customInstructions).toBe(
			compactionFocus("personal"),
		);
		expect(managerCompact.mock.calls[0][0].customInstructions).toBe(
			compactionFocus("manager"),
		);
		expect(personalCompact.mock.calls[0][0].customInstructions).not.toBe(
			managerCompact.mock.calls[0][0].customInstructions,
		);
	});

	it("passes the caller's own instructions through, merged with ours", async () => {
		const { input, compact } = setup({
			callerInstructions: "Keep the SQL schema verbatim.",
		});
		await runFocusedCompaction(input);
		expect(compact.mock.calls[0][0].customInstructions).toContain(
			"Keep the SQL schema verbatim.",
		);
	});

	it("hands Pi's plan back to Pi untouched — the cut point is not ours to choose", async () => {
		const { input, compact } = setup();
		await runFocusedCompaction(input);
		const args = compact.mock.calls[0][0];
		expect(args.preparation).toBe(PREPARATION);
		expect(args.model).toBe(MODEL);
		expect(args.apiKey).toBe("local");
		expect(args.headers).toEqual({ x: "1" });
	});

	it("forwards the abort signal, so a cancelled compaction is cancelled", async () => {
		const controller = new AbortController();
		const { input, compact } = setup({ signal: controller.signal });
		await runFocusedCompaction(input);
		expect(compact.mock.calls[0][0].signal).toBe(controller.signal);
	});

	it("stands aside when there is no model — Pi compacts instead", async () => {
		const { input, compact } = setup({ model: undefined });
		expect(await runFocusedCompaction(input)).toEqual({ kind: "delegate" });
		expect(compact).not.toHaveBeenCalled();
	});

	it("stands aside when the credentials do not resolve", async () => {
		// Pi's own compaction is about to hit the same wall. That is its failure to report,
		// not ours to pre-empt with a summary we cannot write either.
		const { input, compact } = setup({
			auth: vi.fn(async () => ({ ok: false, error: "no api key" })),
		});
		expect(await runFocusedCompaction(input)).toEqual({ kind: "delegate" });
		expect(compact).not.toHaveBeenCalled();
	});

	it("stands aside when the summariser throws, instead of breaking the compaction", async () => {
		const { input } = setup({
			compact: vi.fn(async () => {
				throw new Error("model is down");
			}),
		});
		// A throw is Pi's own failure path and it reports it properly. Standing aside lets it.
		await expect(runFocusedCompaction(input)).resolves.toEqual({
			kind: "delegate",
		});
	});

	it("stands aside when auth itself throws", async () => {
		const { input } = setup({
			auth: vi.fn(async () => {
				throw new Error("registry exploded");
			}),
		});
		await expect(runFocusedCompaction(input)).resolves.toEqual({
			kind: "delegate",
		});
	});

	it("retries without the tool output when the summariser writes nothing", async () => {
		// The live failure: one prompt carrying the whole history, at the moment the context
		// is fullest, and the provider has no room left to answer. So ask again with the tool
		// traffic taken out — most of the tokens, and by our own brief the least of the worth.
		const compact = vi
			.fn()
			.mockResolvedValueOnce(FILE_LIST_ONLY)
			.mockResolvedValueOnce(RESULT);
		const { input } = setup({ compact });
		expect(await runFocusedCompaction(input)).toEqual({
			kind: "compaction",
			compaction: RESULT,
		});
		expect(compact).toHaveBeenCalledTimes(2);
		const retry = compact.mock.calls[1][0];
		// Said, not done: the tool result is gone and so is the call inside the assistant
		// message, but both messages that carry words are still there, in order.
		expect(retry.preparation.messagesToSummarize).toEqual([
			MESSAGES[0],
			{
				role: "assistant",
				content: [{ type: "text", text: "reading the file" }],
			},
		]);
		expect(retry.customInstructions).toContain("only what was SAID remains");
		// Pi's own plan is untouched — the fallback path still has the material it planned on.
		expect(PREPARATION.messagesToSummarize).toBe(MESSAGES);
	});

	it("cancels rather than replace the history with a summary that says nothing", async () => {
		// The bug this whole file exists for: an empty completion plus the file list Pi
		// appends in code passed a `summary.trim()` check, and 96,801 tokens of the owner's
		// session were replaced by an `ls`. Cancelling costs him a full context. Accepting
		// costs him the conversation.
		const compact = vi.fn(async () => FILE_LIST_ONLY);
		const { input } = setup({ compact });
		const result = await runFocusedCompaction(input);
		expect(result.kind).toBe("cancel");
		expect(compact).toHaveBeenCalledTimes(2); // tried, shrank the job, tried again
	});

	it("does not retry when there is nothing left to take away", async () => {
		// A history that is already only words: shrinking it would change nothing, and a
		// second identical call is a second identical failure.
		const compact = vi.fn(async () => FILE_LIST_ONLY);
		const { input } = setup({
			compact,
			preparation: {
				...PREPARATION,
				messagesToSummarize: [MESSAGES[0]],
			},
		});
		expect((await runFocusedCompaction(input)).kind).toBe("cancel");
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
