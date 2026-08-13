import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../../src/core/with-timeout";

describe("withTimeout", () => {
	it("waits for successful cleanup", async () => {
		const cleanup = Promise.resolve();
		await expect(withTimeout(() => cleanup, 20)).resolves.toBe(true);
	});

	it("treats a rejected cleanup as finished", async () => {
		await expect(
			withTimeout(async () => {
				throw new Error("network unavailable");
			}, 20),
		).resolves.toBe(true);
	});

	describe("when cleanup never settles", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("does not resolve before the deadline", async () => {
			let settled = false;
			void withTimeout(() => new Promise(() => {}), 5).then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(4);
			expect(settled).toBe(false);
		});

		it("returns false once the deadline passes", async () => {
			const result = withTimeout(() => new Promise(() => {}), 5);
			await vi.advanceTimersByTimeAsync(5);
			await expect(result).resolves.toBe(false);
		});
	});
});
