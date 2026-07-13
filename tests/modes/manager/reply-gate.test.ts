import { describe, expect, it } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import { ReplyGate } from "../../../src/modes/manager/reply-gate";

const WINDOW = 300_000;

function gate() {
	const clock = new ManualClock(0);
	return {
		gate: new ReplyGate({ ownerReplyWindowMs: WINDOW, clock }),
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

	it("stands the bot down for that batch only — the next message arms a new window", () => {
		// The old `takeover` sub-mode froze the chat outright: once the owner wrote,
		// nothing the interlocutor said afterwards could wake the bot. Now the owner
		// simply took that batch, and the conversation carries on.
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		g.onOwnerMessage("42");

		g.onInterlocutorMessage("42");
		expect(g.hasPending("42")).toBe(true);
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual(["42"]);
	});

	it("re-arms the window on every new interlocutor message", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		clock.advance(WINDOW - 1000);
		// A second message resets the window: the owner gets the full window to answer
		// the batch as it now stands.
		g.onInterlocutorMessage("42");
		clock.advance(1001);
		expect(g.onTick()).toEqual([]);
		clock.advance(WINDOW);
		expect(g.onTick()).toEqual(["42"]);
	});

	it("keeps each chat's window independent", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("a");
		clock.advance(1000);
		g.onInterlocutorMessage("b");
		expect(g.pendingCount()).toBe(2);

		clock.advance(WINDOW - 999);
		expect(g.onTick()).toEqual(["a"]);
		clock.advance(1000);
		expect(g.onTick()).toEqual(["b"]);
	});

	it("drops a served chat", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual(["42"]);
		g.clearServed("42");
		expect(g.hasPending("42")).toBe(false);
		expect(g.pendingCount()).toBe(0);
	});

	it("reports the time left on the window", () => {
		const { gate: g, clock } = gate();
		expect(g.windowRemaining("42")).toBeNull();
		g.onInterlocutorMessage("42");
		clock.advance(100_000);
		expect(g.windowRemaining("42")).toBe(WINDOW - 100_000);
	});

	it("forgets a chat entirely", () => {
		const { gate: g, clock } = gate();
		g.onInterlocutorMessage("42");
		g.remove("42");
		expect(g.hasPending("42")).toBe(false);
		clock.advance(WINDOW + 1);
		expect(g.onTick()).toEqual([]);
	});
});
