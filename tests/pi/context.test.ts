import { describe, expect, it, vi } from "vitest";
import { LatestContext } from "../../src/pi/context";
import type { ExtensionContext } from "../../src/pi/sdk";

function fakeCtx(over: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/work",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		compact: () => {},
		...over,
	} as unknown as ExtensionContext;
}

describe("LatestContext", () => {
	it("exposes a port for the most recent context", () => {
		const holder = new LatestContext();
		expect(holder.port()).toBeUndefined();

		const abort = vi.fn();
		holder.set(fakeCtx({ cwd: "/a", abort }));
		const port = holder.port();
		expect(port?.cwd).toBe("/a");
		expect(port?.isIdle()).toBe(true);
		port?.abort();
		expect(abort).toHaveBeenCalledOnce();
	});

	it("clears the held context on shutdown", () => {
		const holder = new LatestContext();
		holder.set(fakeCtx());
		holder.clear();
		expect(holder.get()).toBeUndefined();
		expect(holder.port()).toBeUndefined();
	});
});
