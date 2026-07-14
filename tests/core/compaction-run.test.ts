import { describe, expect, it, vi } from "vitest";
import { compactionFocus } from "../../src/core/compaction-focus";
import {
	type CompactionAuth,
	runFocusedCompaction,
} from "../../src/core/compaction-run";

type Model = { id: string };
type Preparation = { firstKeptEntryId: string; tokensBefore: number };

const MODEL: Model = { id: "qwen3.6-35b" };
const PREPARATION: Preparation = {
	firstKeptEntryId: "entry-7",
	tokensBefore: 120_712,
};
const OK: CompactionAuth = { ok: true, apiKey: "local", headers: { x: "1" } };

const RESULT = {
	summary: "The owner asked for a Telegram bridge…",
	firstKeptEntryId: "entry-7",
	tokensBefore: 120_712,
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
		...over,
	};
	return { input, compact, auth };
}

describe("runFocusedCompaction", () => {
	it("fills the argument Pi's automatic compaction leaves empty", async () => {
		// This is the entire point: `compact()` takes `customInstructions`, and the path
		// that actually fires in a long session passes `undefined` for it.
		const { input, compact } = setup();
		const result = await runFocusedCompaction(input);
		expect(result).toEqual(RESULT);
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
		expect(await runFocusedCompaction(input)).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});

	it("stands aside when the credentials do not resolve", async () => {
		// Pi's own compaction is about to hit the same wall. That is its failure to report,
		// not ours to pre-empt with a summary we cannot write either.
		const { input, compact } = setup({
			auth: vi.fn(async () => ({ ok: false, error: "no api key" })),
		});
		expect(await runFocusedCompaction(input)).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});

	it("stands aside when the summariser throws, instead of breaking the compaction", async () => {
		const { input } = setup({
			compact: vi.fn(async () => {
				throw new Error("model is down");
			}),
		});
		// Undefined is a complete answer: Pi then compacts exactly as it does today. A
		// worse summary beats a context that never gets compacted.
		await expect(runFocusedCompaction(input)).resolves.toBeUndefined();
	});

	it("stands aside when auth itself throws", async () => {
		const { input } = setup({
			auth: vi.fn(async () => {
				throw new Error("registry exploded");
			}),
		});
		await expect(runFocusedCompaction(input)).resolves.toBeUndefined();
	});

	it("refuses an empty summary — that is a deletion, not a compaction", async () => {
		// The history would be cut away and replaced by nothing.
		const { input } = setup({
			compact: vi.fn(async () => ({ ...RESULT, summary: "   " })),
		});
		expect(await runFocusedCompaction(input)).toBeUndefined();
	});
});
