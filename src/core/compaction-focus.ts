/**
 * What a summariser must not throw away when it rewrites this conversation.
 *
 * A compaction replaces the history with a summary the model writes of itself. Pi's own
 * summarisation prompt is a good one — goal, constraints, progress, decisions, next
 * steps, "preserve exact file paths, function names, and error messages" — and it is
 * written for a coding session. It is handed to the model as the whole brief, with one
 * slot left open for whoever knows something it does not: `customInstructions`, appended
 * as "Additional focus: …". Pi's AUTOMATIC compaction leaves that slot empty
 * (`agent-session.ts` passes `undefined`), which is why we run the compaction ourselves
 * and fill it — see `core/compaction-run.ts`.
 *
 * What we know that the generic prompt does not is an arithmetic fact this bridge can
 * measure and nobody else can see (`/context` prints it): tool output is typically 80-90%
 * of the characters in the context, and the person's own words are two or three. A
 * summariser weighing a conversation by mass writes a beautiful account of the files it
 * read and forgets what it was asked to do with them — which is exactly the bot the owner
 * described: it lost the beginning and started narrating code back at him.
 *
 * So the focus says the opposite of what the token counts say. A file can be read again.
 * A thing the person said an hour ago cannot.
 *
 * Three threads share one Pi session and they are not the same conversation, so they do
 * not get the same brief:
 *
 *  - `personal` — the owner and the model. The summary IS this thread's memory.
 *  - `mixed` — the same thread, with the Telegram moderation turns cut out of the
 *    material before it is summarised (see `stripTelegramTurnsFromCompaction`). The
 *    summariser must be told that the holes are deliberate, or it will try to explain
 *    them.
 *  - `manager` — moderation turns, and only those. This summary is normally never read:
 *    the manager REBUILDS the model's context from the per-chat store on every turn. It
 *    is written anyway, into a session file, so it is told the one thing that matters if
 *    anything ever does read it — other people's private messages do not belong in it.
 *
 * Text only, no logic. It lives in its own file because it is the closest thing this
 * project has to a statement of what the bot is FOR, and it belongs where it can be read
 * and argued with rather than buried in a handler.
 */

/** Which thread a compaction is summarising. Mirrors the mode the bridge is running. */
export type CompactionThread = "personal" | "mixed" | "manager";

/**
 * Every thread gets this, and it is not a style note.
 *
 * The summariser is given one output budget for the whole summary, and a model that
 * spends it before it reaches the end is cut off mid-sentence — or, as happened live,
 * produces nothing at all and lets a file list stand in for an hour of conversation
 * (`core/compaction-run.ts` tells that story). A brief that does not name a size is a
 * brief that invites the model to write until it is stopped.
 */
const LENGTH = [
	"Write the summary and nothing else: no preamble, no deliberation, no restating of this brief.",
	"Aim for 400-600 words. Being complete matters more than being long: a summary that runs out of room mid-thought is worse than a short one that finishes.",
].join("\n");

/**
 * Added on the retry, when the first attempt came back empty and we are summarising the
 * conversation with the tool traffic taken out. The holes are ours; say so, or the model
 * will try to explain them.
 */
export const RETRY_FOCUS = [
	"The tool calls and their output have been removed from the history below — only what was SAID remains.",
	"That is deliberate and it is the point: summarise the conversation. Do not mention the missing tool output or try to reconstruct it.",
].join("\n");

/** The part every thread gets: the person outranks the output. */
const OWNER_THREAD = [
	"This is a person talking to an assistant over Telegram, not only a coding session.",
	"The tool output in this history is most of its bulk and the least of its worth: a file can be read again, a thing the person said an hour ago cannot.",
	"Preserve, in their own words and quoted where short:",
	"- what they originally asked for, and any request of theirs that is still open;",
	"- every instruction, correction and preference they gave about HOW you work or answer — those hold for the rest of the session, not just the turn they were said in;",
	"- anything they asked you to remember, and anything you promised them;",
	"- questions of theirs you have not answered yet.",
	"Compress tool output down to its conclusions: what was found, what was changed, which paths matter. Never compress away the person.",
].join("\n");

/** Mixed only: the material has holes, and they are ours. */
const MIXED_GAPS = [
	"This session also answers other people's Telegram messages on the owner's behalf. Those turns have been removed from the history below on purpose — they are a different conversation and are kept elsewhere.",
	"Do not account for the gaps, do not mention them, and do not try to reconstruct what was cut. Summarise what is here: the owner's own thread.",
].join("\n");

/** Manager only: a summary of other people's chats is a privacy problem, not a memory. */
const MANAGER_THREAD = [
	"This history is turns in which you answered OTHER PEOPLE on the owner's behalf, over Telegram.",
	"Their messages are private and are already stored, per person, outside this summary. Do NOT reproduce them, quote them, or list who said what: nothing anyone confided to the owner belongs in a summary that outlives the chat it was said in.",
	"Keep only what governs how you work: standing instructions from the owner, decisions about how to handle a situation, and anything you were in the middle of doing. One line per person at most, and only for what is still unfinished.",
].join("\n");

/**
 * The summariser's brief for `thread`, plus whatever the caller of `ctx.compact()` asked
 * for (a caller who says something more specific is answering a question we did not know
 * to ask, so their words go last, where they carry the most weight), plus `extra` for the
 * one caller that knows something about the ATTEMPT rather than the thread — the retry.
 */
export function compactionFocus(
	thread: CompactionThread,
	callerInstructions?: string,
	extra?: string,
): string {
	const parts =
		thread === "manager"
			? [MANAGER_THREAD]
			: thread === "mixed"
				? [OWNER_THREAD, MIXED_GAPS]
				: [OWNER_THREAD];
	parts.push(LENGTH);
	const more = extra?.trim();
	if (more) parts.push(more);
	const caller = callerInstructions?.trim();
	if (caller) parts.push(caller);
	return parts.join("\n\n");
}
