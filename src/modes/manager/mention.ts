/**
 * Wake-word matching for the manager (mode 2).
 *
 * A configurable list of trigger words/phrases (`manager.mentionWords`) lets a
 * message jump the owner-reply window and reach the model right away — but ONLY
 * the scheduling is affected; whether to actually answer stays the model's call
 * (a wake-word used in passing is not a question). This module is the pure,
 * unit-testable matcher; the controller decides what to do with a match.
 *
 * Matching is case-insensitive and token-bounded so a wake-word only fires as a
 * whole word/phrase: "llm" matches "Hey LLM, help" but not "llms are great". It
 * is Unicode-aware (via `\p{L}`/`\p{N}`), so non-Latin triggers work too.
 */

/**
 * Links, removed before matching. A URL is not speech: nobody addresses the bot
 * by pasting an address that happens to contain its name.
 *
 * Normalization reduces `/`, `-` and `.` to spaces, so every path segment of a
 * link becomes a bare token — and the default wake-word list is `llm, manager`.
 * A link to this very project (`.../pi-telegram-manager/pull/47`) therefore read
 * as a summons: the owner pasted a PR link, the bot decided it had been called
 * by name, and answered a message that was never addressed to it. That is the
 * one path by which an owner message opens a turn at all, so a false match here
 * costs a reply nobody asked for.
 */
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu;

/**
 * Lowercase and reduce everything that is not a letter or number to single
 * spaces, so a token sits between spaces regardless of surrounding punctuation.
 */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether `text` contains any of `words` as a whole word/phrase
 * (case-insensitive), ignoring anything inside a {@link LINK}.
 */
export function matchesMention(
	text: string,
	words: readonly string[],
): boolean {
	if (!text || words.length === 0) return false;
	const haystack = ` ${normalize(text.replace(LINK, " "))} `;
	return words.some((word) => {
		const needle = normalize(word);
		return needle.length > 0 && haystack.includes(` ${needle} `);
	});
}

/**
 * The effective wake-word list: the configured `mentionWords` PLUS the bot's own
 * label (from `manager.labeler`) as one phrase, so a message that addresses the
 * bot by the name it signs replies with also wakes it. The label is normalized
 * (emoji/punctuation dropped, lower-cased) and only added when non-empty and not
 * already present. `mentionWords` itself is never mutated — the configured list
 * is authoritative and the labeler is a purely additive convenience.
 */
export function withLabelerMention(
	words: readonly string[],
	labeler: string | undefined,
): string[] {
	const label = normalize(labeler ?? "");
	if (!label) return [...words];
	const already = words.some((word) => normalize(word) === label);
	return already ? [...words] : [...words, label];
}
