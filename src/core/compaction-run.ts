/**
 * Run the compaction ourselves, so the summary can be told what to keep.
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
 * What this deliberately does NOT do: it does not choose the moment, it does not choose
 * the cut point (`preparation` is Pi's, untouched), and it adds no compaction that would
 * not have happened anyway. It is the same event, summarised by a model that was told
 * whose words matter.
 *
 * And when anything at all goes wrong, it returns `undefined` — which is a complete,
 * safe answer: Pi then compacts exactly as it does today. A worse summary beats a
 * context that never gets compacted.
 *
 * The SDK arrives through ports so the whole thing is testable without a model.
 */
import { type CompactionThread, compactionFocus } from "./compaction-focus";

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

export interface FocusedCompactionInput<TModel, TPreparation> {
	/** Which thread is being summarised — they do not get the same brief. */
	thread: CompactionThread;
	/** The model the session runs on. Absent → we cannot compact; Pi will. */
	model: TModel | undefined;
	/** Pi's own plan for this compaction: what to summarise, what to keep. Untouched. */
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
}

/**
 * The compaction to hand back to Pi, or `undefined` to let Pi run its own.
 *
 * Never throws: every failure here has the same correct answer, and it is not to break
 * the compaction.
 */
export async function runFocusedCompaction<TModel, TPreparation>(
	input: FocusedCompactionInput<TModel, TPreparation>,
): Promise<CompactionResultLike | undefined> {
	const { model } = input;
	if (!model) return undefined;
	try {
		const auth = await input.auth(model);
		// No key, an expired token, a provider that cannot be reached: Pi's compaction is
		// about to fail on the same wall, and that is its failure to report, not ours to
		// pre-empt with a summary we cannot write either.
		if (!auth.ok) return undefined;
		const result = await input.compact({
			preparation: input.preparation,
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			customInstructions: compactionFocus(
				input.thread,
				input.callerInstructions,
			),
			signal: input.signal,
		});
		// An empty summary is not a compaction, it is a deletion: the history would be
		// cut away and replaced by nothing. Let Pi try instead.
		return result.summary.trim() ? result : undefined;
	} catch {
		return undefined;
	}
}
