import { describe, expect, it } from "vitest";
import { matchesMention } from "../../../src/modes/manager/mention";

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

	it("returns false for empty text or an empty word list", () => {
		expect(matchesMention("", ["llm"])).toBe(false);
		expect(matchesMention("hello llm", [])).toBe(false);
	});
});
