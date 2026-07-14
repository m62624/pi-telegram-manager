import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnSignal } from "../../src/core/turn-signal";

describe("TurnSignal", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("confirms a hand-off the moment the turn starts", async () => {
		const signal = new TurnSignal();
		const confirmed = signal.next(15_000);
		signal.fire();
		expect(await confirmed).toBe(true);
	});

	it("reports the hand-off that never became a turn", async () => {
		// The whole reason this exists. `pi.sendUserMessage` returns void and swallows its
		// own failure, so a prompt thrown away by "Agent is already processing a prompt"
		// looked exactly like a delivered one — and the message was dropped from the queue.
		const signal = new TurnSignal();
		const confirmed = signal.next(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await confirmed).toBe(false);
	});

	it("keeps waiting right up to the deadline", async () => {
		const signal = new TurnSignal();
		const confirmed = signal.next(15_000);
		await vi.advanceTimersByTimeAsync(14_999);
		signal.fire();
		expect(await confirmed).toBe(true);
	});

	it("wakes every waiter, and forgets them", async () => {
		const signal = new TurnSignal();
		const first = signal.next(15_000);
		const second = signal.next(15_000);
		expect(signal.pending).toBe(2);
		signal.fire();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(signal.pending).toBe(0);
	});

	it("leaves nothing behind after a timeout", async () => {
		const signal = new TurnSignal();
		const confirmed = signal.next(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		await confirmed;
		expect(signal.pending).toBe(0);
	});

	it("releases a waiter when the mode goes down, rather than hanging it", async () => {
		const signal = new TurnSignal();
		const confirmed = signal.next(15_000);
		signal.clear();
		expect(await confirmed).toBe(false);
		expect(signal.pending).toBe(0);
	});

	it("does not confirm a hand-off armed AFTER the turn started", async () => {
		// Ordering matters, and the caller depends on it: the waiter is armed before the
		// send precisely because a turn can start immediately.
		const signal = new TurnSignal();
		signal.fire();
		const confirmed = signal.next(15_000);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await confirmed).toBe(false);
	});
});
