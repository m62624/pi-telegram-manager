/**
 * Run the compaction ourselves, so the summary can be told what to keep — and so a
 * summary that says nothing can never be the thing that replaces the conversation.
 *
 * Pi decides WHEN to compact and WHAT to cut, and it should: those are its judgements
 * about its own context window, and we have no better ones. But it also decides what the
 * summariser is TOLD, and there it has a hole. `compact()` takes a `customInstructions`
 * argument; the manual `/compact` path fills it, and the AUTOMATIC path — the one that
 * actually fires in a long session — passes `undefined`. So the compaction that really
 * happens is the one written by the generic prompt, and the generic prompt does not know
 * that four fifths of what it is reading is tool output nobody chose to put there.
 *
 * `session_before_compact` has a documented answer to this, and it is not a hack: an
 * extension may hand Pi the finished `CompactionResult`, which Pi then uses instead of
 * running its own (it even records `fromHook` in the session entry to say so). So we
 * call `compact()` — Pi's own function, exported from its package, the same code that
 * would otherwise run — with the one argument its automatic path leaves empty.
 *
 * ## The summary that was not there
 *
 * A compaction is irreversible: the history is deleted and the summary is what remains.
 * So the summary is checked before it is accepted, and this is why.
 *
 * Live, on the owner's machine: 96,801 tokens of conversation went into a compaction, and
 * what came back — recorded in the session file, `fromHook: true`, ours — was this:
 *
 *     "\n\n<read-files>\n/home/…/src/constants.ts\n/home/…/src/core/abort.ts\n…"
 *
 * A list of file paths. Nothing else. Pi builds the summary as `<what the model wrote> +
 * <file list computed in code>`, the model had written NOTHING (the provider returned an
 * empty completion — `stopReason: "length"` after one token, at a context that big), and
 * the file list made the result non-empty. Our only guard was `summary.trim()`, so it
 * passed, and an hour of the owner's session was replaced by an `ls`. He asked the bot
 * what they had been talking about and it read him the file list back.
 *
 * Hence, in order:
 *
 *  1. **Ask for something a model can finish.** The brief now names a length; a
 *     summariser that runs out of output tokens produces exactly what we saw.
 *  2. **Check what came back.** Strip the file list Pi appended in code — it is not the
 *     model's work and it is not a summary — and require actual prose underneath.
 *  3. **If there is none, shrink the job and ask again.** The failure is at its worst
 *     precisely when the context is at its fullest, which is when compaction runs. So the
 *     retry summarises the CONVERSATION and drops the tool output — the bulk of the
 *     tokens and, by our own brief, the least of the worth.
 *  4. **If that fails too, keep the history.** Not "let Pi try": Pi's own path accepts an
 *     empty summary without looking, which is how this happened. `cancel` leaves the
 *     conversation intact and tells the owner. An un-compacted session is a problem. A
 *     session whose memory was overwritten with a file list is a loss.
 *
 * The SDK arrives through ports so the whole thing is testable without a model.
 */
import {
	type CompactionThread,
	compactionFocus,
	RETRY_FOCUS,
} from "./compaction-focus";

/** What Pi's `compact()` gives back (structurally its `CompactionResult`). */
export interface CompactionResultLike {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

/** Credentials for the summarisation call (structurally `ResolvedRequestAuth`). */
export type CompactionAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

/**
 * The material Pi picked for this compaction. We only ever read `messagesToSummarize`,
 * and only to make it smaller on the retry — the cut point is Pi's and stays Pi's.
 */
export interface PreparationLike {
	messagesToSummarize: unknown[];
}

/** What the hook should do with this compaction. */
export type FocusedCompaction =
	/** Hand Pi this summary — it is a real one. */
	| { kind: "compaction"; compaction: CompactionResultLike }
	/** We cannot summarise (no model, no key). Pi runs its own, as it always has. */
	| { kind: "delegate" }
	/**
	 * The summariser produced no summary, twice. Keep the history: cancelling costs the
	 * owner a full context, accepting costs them the conversation.
	 */
	| { kind: "cancel"; reason: string };

export interface FocusedCompactionInput<
	TModel,
	TPreparation extends PreparationLike,
> {
	/** Which thread is being summarised — they do not get the same brief. */
	thread: CompactionThread;
	/** The model the session runs on. Absent → we cannot compact; Pi will. */
	model: TModel | undefined;
	/** Pi's own plan for this compaction: what to summarise, what to keep. */
	preparation: TPreparation;
	/** Instructions the caller of `ctx.compact()` passed, if any. Merged with ours. */
	callerInstructions?: string;
	signal?: AbortSignal;
	/** `ctx.modelRegistry.getApiKeyAndHeaders` */
	auth: (model: TModel) => Promise<CompactionAuth>;
	/** Pi's own `compact()`, exported from its package. */
	compact: (args: {
		preparation: TPreparation;
		model: TModel;
		apiKey: string | undefined;
		headers: Record<string, string> | undefined;
		customInstructions: string;
		signal: AbortSignal | undefined;
	}) => Promise<CompactionResultLike>;
	/**
	 * The conversation inside `messagesToSummarize`, with the tool traffic left out —
	 * what the retry summarises instead. Injected because "which message is tool output"
	 * is Pi's message schema, not this module's business.
	 */
	conversationOnly: (messages: readonly unknown[]) => unknown[];
}

/**
 * The shortest thing we will call a summary. Not a quality bar — a liveness one: below
 * this, the model did not answer. Pi's own summary of an idle chat runs to ~3,000 chars;
 * the empty one that wiped the owner's session had 0.
 */
export const MIN_SUMMARY_CHARS = 40;

/**
 * The summary with Pi's own additions taken off: it appends `<read-files>` and
 * `<modified-files>` blocks in code, AFTER the model has spoken, so their presence says
 * nothing about whether the model spoke at all.
 */
export function summaryProse(summary: string): string {
	return summary
		.replace(/<read-files>[\s\S]*?<\/read-files>/gi, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>/gi, "")
		.trim();
}

/** Whether a summary carries anything the model actually wrote. */
export function isRealSummary(summary: string): boolean {
	return summaryProse(summary).length >= MIN_SUMMARY_CHARS;
}

/**
 * The compaction to hand back to Pi.
 *
 * Never throws: a failure here must not be the thing that breaks the session.
 */
export async function runFocusedCompaction<
	TModel,
	TPreparation extends PreparationLike,
>(
	input: FocusedCompactionInput<TModel, TPreparation>,
): Promise<FocusedCompaction> {
	const { model } = input;
	if (!model) return { kind: "delegate" };
	try {
		const auth = await input.auth(model);
		// No key, an expired token, a provider that cannot be reached: Pi's compaction is
		// about to fail on the same wall, and that is its failure to report, not ours to
		// pre-empt with a summary we cannot write either.
		if (!auth.ok) return { kind: "delegate" };
		const run = async (
			preparation: TPreparation,
			extra?: string,
		): Promise<CompactionResultLike> =>
			input.compact({
				preparation,
				model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				customInstructions: compactionFocus(
					input.thread,
					input.callerInstructions,
					extra,
				),
				signal: input.signal,
			});

		const first = await run(input.preparation);
		if (isRealSummary(first.summary))
			return { kind: "compaction", compaction: first };

		// Nothing came back. The likeliest reason is size — this call carries the whole
		// history in one prompt, at the exact moment the context is fullest — so ask again
		// with the tool output taken out. It is most of the tokens and, by our own brief,
		// the least of the worth.
		const conversation = input.conversationOnly(
			input.preparation.messagesToSummarize,
		);
		if (
			conversation.length === 0 ||
			conversation.length === input.preparation.messagesToSummarize.length
		) {
			return { kind: "cancel", reason: "the summariser returned nothing" };
		}
		const second = await run(
			{ ...input.preparation, messagesToSummarize: conversation },
			RETRY_FOCUS,
		);
		if (isRealSummary(second.summary))
			return { kind: "compaction", compaction: second };
		return { kind: "cancel", reason: "the summariser returned nothing, twice" };
	} catch (error) {
		// A throw is Pi's own failure path and it reports it properly (a dead provider, an
		// aborted signal). Stand aside and let it.
		void error;
		return { kind: "delegate" };
	}
}
