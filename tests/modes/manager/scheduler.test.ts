import { describe, expect, it } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import { ChatScheduler } from "../../../src/modes/manager/scheduler";

function setup(continueWindowMs = 90_000) {
	const clock = new ManualClock(0);
	const scheduler = new ChatScheduler({ continueWindowMs, clock });
	return { clock, scheduler };
}

describe("ChatScheduler", () => {
	it("makes the first chat active and queues the rest FIFO", () => {
		const { scheduler } = setup();
		expect(scheduler.onMessage("a")).toBe("active");
		expect(scheduler.onMessage("b")).toBe("queued");
		expect(scheduler.onMessage("c")).toBe("queued");
		expect(scheduler.activeChat()).toBe("a");
		expect(scheduler.pending()).toEqual(["b", "c"]);
		expect(scheduler.size).toBe(3);
	});

	it("does not double-queue a chat that messages twice while waiting", () => {
		const { scheduler } = setup();
		scheduler.onMessage("a"); // active
		scheduler.onMessage("b"); // queued
		expect(scheduler.onMessage("b")).toBe("queued");
		expect(scheduler.pending()).toEqual(["b"]);
	});

	it("treats a message from the active chat as a continuation", () => {
		const { scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onReplied();
		expect(scheduler.continuationRemaining()).toBe(90_000);
		expect(scheduler.onMessage("a")).toBe("continued");
		// The pending window is cancelled once they answer.
		expect(scheduler.continuationRemaining()).toBeNull();
	});

	it("keeps the chat active when the interlocutor replies within the window", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b"); // waiting
		scheduler.onReplied();
		clock.advance(80_000); // still inside the 90s window
		expect(scheduler.onMessage("a")).toBe("continued");
		clock.advance(80_000); // window was reset on their message; still active
		expect(scheduler.onTick()).toEqual({ released: null, promoted: null });
		expect(scheduler.activeChat()).toBe("a");
		expect(scheduler.pending()).toEqual(["b"]);
	});

	it("releases the active chat and promotes the next when the window expires", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		scheduler.onReplied();
		clock.advance(90_001);
		expect(scheduler.onTick()).toEqual({ released: "a", promoted: "b" });
		expect(scheduler.activeChat()).toBe("b");
		expect(scheduler.pending()).toEqual([]);
	});

	it("goes idle when the window expires and nothing is queued", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onReplied();
		clock.advance(90_001);
		expect(scheduler.onTick()).toEqual({ released: "a", promoted: null });
		expect(scheduler.activeChat()).toBeNull();
		expect(scheduler.size).toBe(0);
	});

	it("does not promote before the window is due", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		scheduler.onReplied();
		clock.advance(89_999);
		expect(scheduler.onTick()).toEqual({ released: null, promoted: null });
		expect(scheduler.activeChat()).toBe("a");
	});

	it("a released chat re-queues at the back on its next message", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		scheduler.onReplied();
		clock.advance(90_001);
		scheduler.onTick(); // a released, b active
		expect(scheduler.onMessage("a")).toBe("queued");
		expect(scheduler.pending()).toEqual(["a"]);
	});

	it("promotes the next chat when the active one is removed", () => {
		const { scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		expect(scheduler.remove("a")).toEqual({ promoted: "b" });
		expect(scheduler.activeChat()).toBe("b");
	});

	it("removes a waiting chat without disturbing the active one", () => {
		const { scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		scheduler.onMessage("c");
		expect(scheduler.remove("b")).toEqual({ promoted: null });
		expect(scheduler.activeChat()).toBe("a");
		expect(scheduler.pending()).toEqual(["c"]);
	});

	it("promotes never-replied chats ahead of already-replied ones", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a"); // active
		scheduler.onMessage("b"); // queued, replies 0
		scheduler.onMessage("c"); // queued, replies 0
		scheduler.onReplied(); // a replies -> 1, continuation armed
		clock.advance(90_001);
		scheduler.onTick(); // release a; among [b,c] both 0 -> FIFO picks b
		expect(scheduler.activeChat()).toBe("b");
		expect(scheduler.repliesFor("a")).toBe(1);
		scheduler.onMessage("a"); // a re-enters the queue with replies 1
		scheduler.onReplied(); // b replies -> 1
		clock.advance(90_001);
		scheduler.onTick(); // among [c(0), a(1)] the never-replied c wins
		expect(scheduler.activeChat()).toBe("c");
	});

	it("a promoted chat has no continuation window until it is replied to", () => {
		const { clock, scheduler } = setup();
		scheduler.onMessage("a");
		scheduler.onMessage("b");
		scheduler.onReplied();
		clock.advance(90_001);
		scheduler.onTick(); // b promoted
		expect(scheduler.continuationRemaining()).toBeNull();
		// A stray tick must not release the freshly promoted chat.
		clock.advance(90_001);
		expect(scheduler.onTick()).toEqual({ released: null, promoted: null });
		expect(scheduler.activeChat()).toBe("b");
	});
});
