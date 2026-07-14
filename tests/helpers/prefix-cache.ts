/**
 * A prefix cache, modelled on what a serving backend actually does with a prompt.
 *
 * Every stack rewards exactly one thing: a prompt that BEGINS with bytes it has already
 * read. llama.cpp matches a slot's cached tokens against the new prompt and re-reads only
 * the difference; vLLM and SGLang do the same with a radix tree; Anthropic's prompt cache
 * is the same idea with explicit breakpoints. None of them can be asked to keep anything.
 * All of them reuse whatever prefix happens to match.
 *
 * So the only lever this project has over the cost of a turn is the prompt itself — and
 * the only honest way to know whether we are using that lever is to measure it. Hence
 * this: a bounded set of previously-served prompts, and, for each new one, the longest
 * common prefix with the best of them.
 *
 * Characters stand in for tokens. They are not the same thing, and it does not matter:
 * every number this reports is a RATIO of one prompt's prefix to its length, and the two
 * units are monotone in each other. What it will not tell you is milliseconds — for that,
 * run the model.
 *
 * Modelled on llama.cpp's `server_prompt_cache::load`, including the rule that keeps a
 * large cached prompt from being trashed by a small one that happens to share its head.
 */
export class PrefixCache {
	private readonly served: string[] = [];

	/** How many prompts the backend keeps (llama.cpp: bounded by `--cache-ram`). */
	constructor(private readonly capacity = 8) {}

	/**
	 * Serve a prompt. Returns how much of it the backend has to READ AGAIN — in characters,
	 * because that is what costs time, and in a ratio, because that is what reads well.
	 *
	 * Watch the characters, not the percentage. A context whose constant part is 24 KB of
	 * rules scores 96% no matter what we do to the other kilobyte, and 96% of nothing is
	 * still nothing. The number that costs seconds is `reread`.
	 */
	serve(prompt: string): { reread: number; reuse: number } {
		let best = 0;
		for (const cached of this.served) {
			const shared = commonPrefixLength(cached, prompt);
			if (shared > best) best = shared;
		}
		this.remember(prompt);
		return {
			reread: prompt.length - best,
			reuse: prompt.length === 0 ? 1 : best / prompt.length,
		};
	}

	private remember(prompt: string): void {
		// An exact re-serve of something we hold is not a new entry.
		const existing = this.served.indexOf(prompt);
		if (existing >= 0) {
			this.served.splice(existing, 1);
		}
		this.served.unshift(prompt);
		if (this.served.length > this.capacity) this.served.pop();
	}
}

/** Characters two strings share from the start. */
export function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
	return i;
}

/** A message as any of our builders produce it. */
export interface PromptMessage {
	role: string;
	content: unknown;
}

/**
 * The bytes the model reads, in order.
 *
 * A chat template renders each message as a role marker followed by its content, one
 * after another, into a single flat token sequence — which is why a message BOUNDARY is
 * not a cache boundary: a volatile string appended to the end of an otherwise-constant
 * message only costs what follows it, and a volatile string in the MIDDLE of one costs
 * everything after it, message boundaries be damned. This serialisation keeps that
 * property, which is the whole point of measuring here rather than eyeballing the code.
 */
export function serializePrompt(
	messages: readonly PromptMessage[] | undefined,
): string {
	if (!messages) return "";
	return messages
		.map((message) => `<|${message.role}|>${textOf(message.content)}`)
		.join("");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("");
}

/** Mean of a run of ratios, as a percentage rounded to one decimal. */
export function meanPercent(ratios: readonly number[]): number {
	if (ratios.length === 0) return 0;
	const total = ratios.reduce((sum, value) => sum + value, 0);
	return Math.round((total / ratios.length) * 1000) / 10;
}
