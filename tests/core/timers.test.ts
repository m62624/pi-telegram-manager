import { describe, expect, it } from "vitest";
import { ManualClock, TIMER, TimerRegistry } from "../../src/core/timers";

describe("TimerRegistry", () => {
	it("fires a timer only once its delay elapses", () => {
		const clock = new ManualClock(0);
		const timers = new TimerRegistry(clock);
		timers.arm("chatA", TIMER.continueWindow, 90_000);

		expect(timers.isArmed("chatA", TIMER.continueWindow)).toBe(true);
		clock.advance(89_999);
		expect(timers.collectDue()).toEqual([]);
		clock.advance(1);
		const due = timers.collectDue();
		expect(due.map((d) => d.name)).toEqual([TIMER.continueWindow]);
		// Firing consumes it.
		expect(timers.isArmed("chatA", TIMER.continueWindow)).toBe(false);
	});

	it("re-arming resets the countdown", () => {
		const clock = new ManualClock(0);
		const timers = new TimerRegistry(clock);
		timers.arm("c", TIMER.ownerReply, 300_000);
		clock.advance(299_000);
		timers.arm("c", TIMER.ownerReply, 300_000); // reset near expiry
		clock.advance(1000);
		expect(timers.collectDue()).toEqual([]);
		expect(timers.remaining("c", TIMER.ownerReply)).toBe(299_000);
	});

	it("cancel and cancelChat remove timers", () => {
		const clock = new ManualClock(0);
		const timers = new TimerRegistry(clock);
		timers.arm("c", TIMER.continueWindow, 1000);
		timers.arm("c", TIMER.ownerReply, 1000);
		timers.arm("d", TIMER.continueWindow, 1000);

		timers.cancel("c", TIMER.continueWindow);
		expect(timers.isArmed("c", TIMER.continueWindow)).toBe(false);
		expect(timers.isArmed("c", TIMER.ownerReply)).toBe(true);

		timers.cancelChat("c");
		expect(timers.isArmed("c", TIMER.ownerReply)).toBe(false);
		expect(timers.isArmed("d", TIMER.continueWindow)).toBe(true);
		expect(timers.size).toBe(1);
	});

	it("collectDue returns all timers due across chats", () => {
		const clock = new ManualClock(0);
		const timers = new TimerRegistry(clock);
		timers.arm("a", TIMER.continueWindow, 100);
		timers.arm("b", TIMER.continueWindow, 100);
		timers.arm("c", TIMER.continueWindow, 500);
		clock.advance(100);
		const due = timers.collectDue();
		expect(due.map((d) => d.chatId).sort()).toEqual(["a", "b"]);
		expect(timers.size).toBe(1);
	});
});
