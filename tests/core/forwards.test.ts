import { describe, expect, it } from "vitest";
import {
	ForwardBursts,
	type ForwardPolicy,
	forwardLimitNote,
	limitForwardText,
} from "../../src/core/forwards";

const POLICY: ForwardPolicy = {
	maxChars: 10,
	maxMessages: 2,
	groupWindowMs: 1000,
};

describe("ForwardBursts", () => {
	it("returns nothing for an ordinary message", () => {
		const bursts = new ForwardBursts(POLICY);
		expect(bursts.track("chat", false, 0)).toBeNull();
	});

	it("keeps consecutive forwards in one batch, so they fold into one turn", () => {
		const bursts = new ForwardBursts(POLICY);
		const first = bursts.track("chat", true, 0);
		const second = bursts.track("chat", true, 500);
		expect(first?.key).toBe(second?.key);
		expect(first?.index).toBe(1);
		expect(second?.index).toBe(2);
	});

	it("starts a new batch after the quiet window", () => {
		const bursts = new ForwardBursts(POLICY);
		const first = bursts.track("chat", true, 0);
		const later = bursts.track("chat", true, 1001);
		expect(later?.key).not.toBe(first?.key);
		expect(later?.index).toBe(1);
	});

	it("a message the sender typed themselves closes the batch", () => {
		const bursts = new ForwardBursts(POLICY);
		const first = bursts.track("chat", true, 0);
		bursts.track("chat", false, 10);
		const after = bursts.track("chat", true, 20);
		expect(after?.key).not.toBe(first?.key);
		expect(after?.index).toBe(1);
	});

	it("keeps batches of different chats apart", () => {
		const bursts = new ForwardBursts(POLICY);
		const a = bursts.track("a", true, 0);
		const b = bursts.track("b", true, 0);
		expect(a?.key).not.toBe(b?.key);
		expect(b?.index).toBe(1);
	});

	it("marks everything past maxMessages as over the limit, and says so exactly once", () => {
		const bursts = new ForwardBursts(POLICY);
		expect(bursts.track("chat", true, 0)?.overLimit).toBe(false);
		expect(bursts.track("chat", true, 1)?.overLimit).toBe(false);
		const third = bursts.track("chat", true, 2);
		expect(third?.overLimit).toBe(true);
		expect(third?.justHitLimit).toBe(true);
		const fourth = bursts.track("chat", true, 3);
		expect(fourth?.overLimit).toBe(true);
		expect(fourth?.justHitLimit).toBe(false);
	});

	it("never limits the count when maxMessages is 0", () => {
		const bursts = new ForwardBursts({ ...POLICY, maxMessages: 0 });
		for (let i = 0; i < 50; i += 1) {
			expect(bursts.track("chat", true, i)?.overLimit).toBe(false);
		}
	});

	it("counts a forwarded ALBUM as one forward, not one per photo", () => {
		// Telegram sends an album as one message per photo. Forwarding it was one act,
		// so a ten-photo album must not eat the whole batch budget by itself.
		const bursts = new ForwardBursts(POLICY);
		const first = bursts.track("chat", true, 0, "album-1");
		const second = bursts.track("chat", true, 10, "album-1");
		const third = bursts.track("chat", true, 20, "album-1");
		expect(first?.index).toBe(1);
		expect(second?.index).toBe(1);
		expect(third?.index).toBe(1);
		expect(third?.overLimit).toBe(false);

		// A different album is a different forward.
		const other = bursts.track("chat", true, 30, "album-2");
		expect(other?.index).toBe(2);
		expect(other?.overLimit).toBe(false);
		// And the next one crosses the limit of 2.
		const beyond = bursts.track("chat", true, 40, "album-3");
		expect(beyond?.overLimit).toBe(true);
		expect(beyond?.justHitLimit).toBe(true);
	});

	it("never repeats the limit note for the photos of one refused album", () => {
		const bursts = new ForwardBursts(POLICY);
		bursts.track("chat", true, 0);
		bursts.track("chat", true, 1);
		const first = bursts.track("chat", true, 2, "album-x");
		const second = bursts.track("chat", true, 3, "album-x");
		expect(first?.justHitLimit).toBe(true);
		expect(second?.overLimit).toBe(true);
		expect(second?.justHitLimit).toBe(false);
	});

	it("forgets a scope on request", () => {
		const bursts = new ForwardBursts(POLICY);
		const first = bursts.track("chat", true, 0);
		bursts.forget("chat");
		const after = bursts.track("chat", true, 1);
		expect(after?.key).not.toBe(first?.key);
	});
});

describe("limitForwardText", () => {
	it("leaves a body within budget untouched", () => {
		expect(limitForwardText("short", 10)).toBe("short");
	});

	it("cuts an over-long body and says how much was not read", () => {
		expect(limitForwardText("0123456789abcde", 10)).toBe(
			"0123456789…[+5 chars not read]",
		);
	});

	it("does not cap at all when maxChars is 0", () => {
		const long = "x".repeat(5000);
		expect(limitForwardText(long, 0)).toBe(long);
	});
});

describe("forwardLimitNote", () => {
	it("names how many were read, in singular and plural", () => {
		expect(forwardLimitNote(1)).toContain("1 forwarded message read");
		expect(forwardLimitNote(5)).toContain("5 forwarded messages read");
	});
});
