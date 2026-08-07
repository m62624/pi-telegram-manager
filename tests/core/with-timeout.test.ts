import { describe, expect, it } from "vitest";
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

	it("returns after the deadline when cleanup never settles", async () => {
		const started = Date.now();
		await expect(withTimeout(() => new Promise(() => {}), 5)).resolves.toBe(
			false,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(5);
	});
});
