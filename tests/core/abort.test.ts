import { describe, expect, it, vi } from "vitest";
import { AbortRegistry } from "../../src/core/abort";

describe("AbortRegistry", () => {
	it("is disarmed until a handler is set", async () => {
		const registry = new AbortRegistry();
		expect(registry.isArmed()).toBe(false);
		expect(await registry.abort()).toBe(false);
	});

	it("invokes the armed handler and reports success", async () => {
		const registry = new AbortRegistry();
		const handler = vi.fn();
		registry.set(handler);
		expect(registry.isArmed()).toBe(true);
		expect(await registry.abort()).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("awaits an async handler", async () => {
		const registry = new AbortRegistry();
		let resolved = false;
		registry.set(async () => {
			await Promise.resolve();
			resolved = true;
		});
		await registry.abort();
		expect(resolved).toBe(true);
	});

	it("no longer fires once cleared", async () => {
		const registry = new AbortRegistry();
		const handler = vi.fn();
		registry.set(handler);
		registry.clear();
		expect(registry.isArmed()).toBe(false);
		expect(await registry.abort()).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it("replaces a previously armed handler", async () => {
		const registry = new AbortRegistry();
		const first = vi.fn();
		const second = vi.fn();
		registry.set(first);
		registry.set(second);
		await registry.abort();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});
