/**
 * What the model is shown out of its own memory, and how it is asked for.
 *
 * Two pure functions and one hard rule about where the result goes.
 *
 * **The rule.** The block belongs in the TRAILING message, under the transcript,
 * next to the clock and the turn's directive — never above it. Everything a backend
 * caches is a prefix, so anything written above the conversation is charged the whole
 * conversation whenever it changes, and a recall changes every single turn by
 * construction. The bench that priced this (`tests/modes/manager/prefix-reuse.test.ts`)
 * caught the old facts block doing exactly that: one newly learned fact cost 19,397
 * characters of re-reading, because it sat one line too high.
 *
 * **The query.** What the recall asks about is the batch nobody has answered yet —
 * not the whole window. A conversation's older turns are already in the transcript
 * verbatim; asking the memory about them again spends the budget re-fetching what the
 * model can already read. What is worth spending it on is what was just said.
 */
import type { ChatMessageRecord } from "../../storage/chat-store";
import { ownWords } from "../../storage/chat-store";

/**
 * Longest query text sent to a recall.
 *
 * Lexical retrieval degrades as a query grows: every extra term is another posting
 * list to fuse, and a wall of pasted text drowns the two or three words that actually
 * identify what is being asked. This is a ceiling on pathology (somebody pasting an
 * essay), not a budget — an ordinary batch is far below it.
 */
const MAX_QUERY_CHARS = 600;

/**
 * The text a recall should be run on: the unanswered tail of the transcript, newest
 * last, in the speakers' own words.
 *
 * "Own words" is not a nicety — `ownWords` strips what a message merely QUOTED or
 * forwarded, and a reply that quotes three paragraphs would otherwise make the query
 * about somebody else's text. Returns `""` when there is nothing outstanding, which
 * the caller reads as "do not spend a recall on this turn".
 */
export function recallQuery(records: readonly ChatMessageRecord[]): string {
	const tail: string[] = [];
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i];
		// A reply of ours, or a line the owner typed, closes the batch: everything
		// older has been dealt with by somebody.
		if (record.author === "bot" || record.author === "owner") break;
		const words = ownWords(record);
		if (words) tail.unshift(words);
	}
	if (tail.length === 0) return "";
	const joined = tail.join("\n");
	return joined.length > MAX_QUERY_CHARS
		? joined.slice(joined.length - MAX_QUERY_CHARS)
		: joined;
}

/**
 * Drop the recalled lines the model can already read in the transcript above.
 *
 * Every inbound message is stored as an episode, so the batch just received is in the
 * memory within milliseconds of arriving — and a recall about that batch ranks it
 * first, by construction. Left alone, the memory block opens by quoting back the
 * sentence sitting three lines above it, which costs tokens to say nothing and makes
 * the section look like noise on exactly the turns it should be trusted.
 *
 * The rule it enforces is worth stating plainly, because it is what the block is FOR:
 * the memory answers about what the transcript cannot show. Anything the window still
 * holds is the window's job.
 *
 * Matching is on the fact's text appearing in a record's own words (or the reverse) —
 * the rendered line carries decoration around it (`- [f3] Alice: … #episode`), and a
 * stored episode is the message's own words, so containment is the honest test.
 */
export function dropVisible(
	rendered: string,
	records: readonly ChatMessageRecord[],
): string {
	const said = records
		.map((record) => normalize(ownWords(record)))
		.filter((text) => text.length > 0);
	if (said.length === 0) return rendered;
	const kept = rendered.split("\n").filter((line) => {
		if (!isFactLine(line)) return true;
		const body = normalize(line);
		return !said.some((text) => body.includes(text));
	});
	// A heading with every line under it removed is worse than no heading at all: it
	// says the memory answered, and shows nothing.
	if (!kept.some(isFactLine)) return "";
	return kept.join("\n").trim();
}

/** A rendered recall is a heading and then one bullet per fact; this is a bullet. */
function isFactLine(line: string): boolean {
	return line.trimStart().startsWith("-");
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Wrap a rendered recall for the prompt — or return `""` when there is nothing.
 *
 * The empty case matters more than it looks. A heading with nothing under it is a
 * tax charged on every turn of every chat that has no memory yet, and worse, it
 * teaches a small model that the memory section is usually noise. No facts, no block.
 *
 * The wording tells the model three things, in this order, because a weak local model
 * acts on the last instruction it read: this is YOUR memory (not something the person
 * said), it may be irrelevant (so ignoring it is allowed and expected), and if it IS
 * relevant then do not ask for what is already here.
 */
export function memoryBlock(rendered: string, contactName: string): string {
	const body = rendered.trim();
	if (!body) return "";
	return (
		`What you remember about ${contactName}, retrieved for the messages above:\n\n` +
		`${body}\n\n` +
		"This is your own memory, not something they just said. It is retrieved by " +
		"relevance and may be off-target — if none of it bears on the messages above, " +
		"ignore it entirely and answer as if it were not here. If it does bear on " +
		"them, use it, and do not ask them for anything it already tells you."
	);
}

/**
 * The same, for an idle consolidation pass, where the block is not context for a
 * reply but the working material of the pass itself.
 *
 * It says what the reply-turn wording must not: the ids are actionable. `[f3]` in the
 * block is the `3` that `manager_forget` and `manager_revise` take, and a model that
 * is not told so will describe what it wants to change instead of changing it.
 */
export function consolidationMemoryBlock(rendered: string): string {
	const body = rendered.trim();
	if (!body) {
		return "Your memory about this person is empty — nothing has been stored yet.";
	}
	return (
		`What you currently remember about this person:\n\n${body}\n\n` +
		"The number in each [fN] tag is that fact's id: pass it to manager_revise to " +
		"replace it, or manager_forget to drop it. Each line is FORMATTED for you: the " +
		"fact itself is the sentence, while `(2026-08; active)` is when it has held and " +
		"`#tags` are how it is filed — never copy those into a fact you write. Use " +
		"manager_recall only for a concrete unresolved point; manager_remember refuses " +
		"on its own to write a fact the memory already holds."
	);
}
