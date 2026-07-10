import { describe, expect, it } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import { ReplyGate } from "../../../src/modes/manager/submode";

const WINDOW = 300_000;

function gate(subMode: "observer" | "takeover" = "observer") {
	const clock = new ManualClock(0);
	return {
		gate: new ReplyGate({ subMode, ownerReplyWindowMs: WINDOW, clock }),
		clock,
	};
}

describe("ReplyGate", () => {
	it("holds an interlocutor message until the owner-reply window expires", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		expect(g.hasPending("42")).toBe(true);
		// Before the window expires, nothing is ready.
		clock.advance(WINDOW - 1);
		expect(g.onTick()).toEqual([]);
		// After it expires in silence, the chat is ready.
		clock.advance(2);
		expect(g.onTick()).toEqual(["42"]);
	});

	it("cancels the batch when the owner answers within the window", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		g.onOwnerMessage("42"); // owner handled it
		expect(g.hasPending("42")).toBe(false);
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual([]); // never becomes ready
	});

	it("takeover: an owner message freezes the chat; window expiry unfreezes", () => {
		const { gate: g, clock } = gate("takeover");
		g.onInterlocutorMessage("42");
		g.onOwnerMessage("42");
		expect(g.isFrozen("42")).toBe(true);
		// A new interlocutor message re-arms the window; expiry unfreezes + ready.
		g.onInterlocutorMessage("42");
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual(["42"]);
		expect(g.isFrozen("42")).toBe(false);
	});

	it("observer: an owner message never freezes", () => {
		const { gate: g } = gate("observer");
		g.onInterlocutorMessage("42");
		g.onOwnerMessage("42");
		expect(g.isFrozen("42")).toBe(false);
	});

	it("clearServed drops a served chat's pending batch", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual(["42"]);
		g.clearServed("42");
		// A fresh window is needed for it to become ready again.
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual([]);
	});

	it("keeps per-chat state and forgets a chat on remove", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		g.onInterlocutorMessage("43");
		clock.advance(WINDOW + 1);
		expect(g.onTick().sort()).toEqual(["42", "43"]);
		g.remove("42");
		expect(g.hasPending("42")).toBe(false);
		expect(g.hasPending("43")).toBe(true);
	});

	it("reports the remaining window time", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		clock.advance(100_000);
		expect(g.windowRemaining("42")).toBe(WINDOW - 100_000);
		expect(g.windowRemaining("99")).toBeNull();
	});
});
