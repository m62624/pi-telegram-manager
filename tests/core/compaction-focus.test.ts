import { describe, expect, it } from "vitest";
import { compactionFocus } from "../../src/core/compaction-focus";

describe("compactionFocus", () => {
	it("tells the summariser the person outranks the tool output", () => {
		// The whole reason this text exists. Tool output is 80-90% of the characters in a
		// working context and the person's words are two or three, so a summariser weighing
		// the conversation by mass writes a beautiful account of the files it read and
		// forgets what it was asked to do with them.
		const focus = compactionFocus("personal");
		expect(focus).toContain("a file can be read again");
		expect(focus).toMatch(/what they originally asked for/i);
		expect(focus).toMatch(/never compress away the person/i);
	});

	it("keeps standing instructions alive past the turn they were given in", () => {
		expect(compactionFocus("personal")).toMatch(
			/hold for the rest of the session/i,
		);
	});

	it("tells mixed that the holes in the history are deliberate", () => {
		// In mixed the Telegram moderation turns are cut out of the material before it is
		// summarised. Unwarned, the summariser tries to explain the gaps it can see.
		const focus = compactionFocus("mixed");
		expect(focus).toMatch(/removed from the history below on purpose/i);
		expect(focus).toMatch(/do not account for the gaps/i);
		// It is still the owner's thread, so it still gets the owner's brief.
		expect(focus).toContain("a file can be read again");
	});

	it("forbids a manager summary from carrying other people's words", () => {
		// A summary of moderation turns is a privacy problem, not a memory: it would lift
		// what strangers said in confidence into a file that outlives their chat. The
		// manager's real memory is the per-chat store and the facts it consolidates.
		const focus = compactionFocus("manager");
		expect(focus).toMatch(/do not reproduce them/i);
		expect(focus).toMatch(/private/i);
		// And it must NOT be told to preserve "what they asked for" — that instruction
		// belongs to the owner's thread, and here "they" would be a stranger.
		expect(focus).not.toContain("what they originally asked for");
	});

	it("gives the last word to the caller of /compact", () => {
		const focus = compactionFocus("personal", "Keep the SQL schema verbatim.");
		expect(focus).toContain("Keep the SQL schema verbatim.");
		expect(focus.trimEnd().endsWith("Keep the SQL schema verbatim.")).toBe(
			true,
		);
	});

	it("ignores a caller who passed nothing but whitespace", () => {
		expect(compactionFocus("personal", "   ")).toBe(
			compactionFocus("personal"),
		);
		expect(compactionFocus("personal", undefined)).toBe(
			compactionFocus("personal"),
		);
	});
});
