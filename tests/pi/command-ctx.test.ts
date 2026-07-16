import { describe, expect, it, vi } from "vitest";
import { commandContextFromBase } from "../../src/pi/command-ctx";
import type { ExtensionContext } from "../../src/pi/sdk";

/** A base context with just the surface the adapter forwards or the test exercises. */
function baseCtx(over: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/project",
		hasUI: true,
		mode: "tui",
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => "sid-1" },
		isIdle: () => true,
		...over,
	} as unknown as ExtensionContext;
}

describe("commandContextFromBase", () => {
	it("forwards base properties and methods to the underlying context", () => {
		const base = baseCtx();
		const ctx = commandContextFromBase(base);
		expect(ctx.cwd).toBe("/project");
		expect(ctx.hasUI).toBe(true);
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.sessionManager.getSessionId()).toBe("sid-1");
	});

	it("reads the live value of a forwarded method, not a snapshot", () => {
		let idle = false;
		const ctx = commandContextFromBase(baseCtx({ isIdle: () => idle }));
		expect(ctx.isIdle()).toBe(false);
		idle = true;
		expect(ctx.isIdle()).toBe(true);
	});

	it("resolves waitForIdle once the base reports idle", async () => {
		let idle = false;
		const ctx = commandContextFromBase(baseCtx({ isIdle: () => idle }));
		const waited = ctx.waitForIdle();
		let settled = false;
		void waited.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false); // still polling — the base is not idle yet
		idle = true;
		await waited;
		expect(settled).toBe(true);
	});

	it("stubs the session-control methods it must never actually perform", async () => {
		const ctx = commandContextFromBase(baseCtx());
		expect(await ctx.newSession()).toEqual({ cancelled: true });
		expect(await ctx.switchSession("/x")).toEqual({ cancelled: true });
		expect(await ctx.fork("id")).toEqual({ cancelled: true });
	});
});
