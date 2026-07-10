import { describe, expect, it } from "vitest";
import { ContextReset } from "../../src/core/context-reset";

const msg = (timestamp: number, id: string) => ({ timestamp, id });

describe("ContextReset", () => {
	it("leaves context untouched (undefined) with no boundary", () => {
		const reset = new ContextReset();
		expect(reset.isActive()).toBe(false);
		expect(reset.apply([msg(1, "a"), msg(2, "b")])).toBeUndefined();
	});

	it("drops messages older than the boundary once cleared", () => {
		const reset = new ContextReset();
		reset.clear(100);
		expect(reset.isActive()).toBe(true);
		const kept = reset.apply([
			msg(50, "old"),
			msg(99, "old2"),
			msg(100, "at-boundary"),
			msg(150, "new"),
		]);
		expect(kept?.map((m) => m.id)).toEqual(["at-boundary", "new"]);
	});

	it("treats a message with no timestamp as oldest (dropped)", () => {
		const reset = new ContextReset();
		reset.clear(10);
		const kept = reset.apply([{ id: "notime" }, msg(20, "new")] as {
			timestamp?: number;
			id: string;
		}[]);
		expect(kept?.map((m) => m.id)).toEqual(["new"]);
	});

	it("forget() restores full history", () => {
		const reset = new ContextReset();
		reset.clear(100);
		reset.forget();
		expect(reset.isActive()).toBe(false);
		expect(reset.apply([msg(1, "a")])).toBeUndefined();
	});
});
