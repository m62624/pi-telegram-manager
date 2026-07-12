import { describe, expect, it } from "vitest";
import {
	matchesMention,
	withLabelerMention,
} from "../../../src/modes/manager/mention";

describe("matchesMention", () => {
	it("matches a wake-word as a whole word, case-insensitively", () => {
		expect(matchesMention("Hey LLM, can you help?", ["llm"])).toBe(true);
		expect(matchesMention("hey llm", ["LLM"])).toBe(true);
	});

	it("does not match a wake-word embedded in a longer token", () => {
		expect(matchesMention("llms are great", ["llm"])).toBe(false);
		expect(matchesMention("callme", ["llm"])).toBe(false);
	});

	it("ignores surrounding punctuation", () => {
		expect(matchesMention("...llm!?", ["llm"])).toBe(true);
		expect(matchesMention("(qwen)", ["qwen"])).toBe(true);
	});

	it("matches a multi-word phrase and is Unicode-aware", () => {
		expect(matchesMention("Эй, Qwen! ты тут?", ["эй qwen"])).toBe(true);
		expect(matchesMention("привет всем", ["эй qwen"])).toBe(false);
	});

	it("matches a spaced phrase regardless of case or punctuation between words", () => {
		expect(matchesMention("hey Mini Bro, look", ["mini bro"])).toBe(true);
		expect(matchesMention("mini, bro!", ["mini bro"])).toBe(true);
		// A phrase must appear as whole words in order, not as a fragment.
		expect(matchesMention("minibro", ["mini bro"])).toBe(false);
		expect(matchesMention("bro mini", ["mini bro"])).toBe(false);
	});

	it("returns false for empty text or an empty word list", () => {
		expect(matchesMention("", ["llm"])).toBe(false);
		expect(matchesMention("hello llm", [])).toBe(false);
	});
});

describe("withLabelerMention", () => {
	it("adds the normalized labeler as a wake phrase", () => {
		expect(withLabelerMention(["llm"], "LLM agent 🤖:")).toEqual([
			"llm",
			"llm agent",
		]);
		// The added phrase then matches when addressed.
		const words = withLabelerMention([], "Support Bot:");
		expect(matchesMention("hey Support Bot, help", words)).toBe(true);
	});

	it("does not duplicate a labeler already present (normalized compare)", () => {
		expect(withLabelerMention(["LLM Agent"], "llm agent 🤖")).toEqual([
			"LLM Agent",
		]);
	});

	it("leaves the list untouched for an empty/emoji-only labeler", () => {
		expect(withLabelerMention(["llm"], "")).toEqual(["llm"]);
		expect(withLabelerMention(["llm"], "🤖")).toEqual(["llm"]);
		expect(withLabelerMention(["llm"], undefined)).toEqual(["llm"]);
	});
});
