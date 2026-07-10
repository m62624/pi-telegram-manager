import { describe, expect, it } from "vitest";
import type { ToolCallEventResult } from "../../src/pi/sdk";
import { createToolMatcher } from "../../src/pi/tool-allow";
import { registerToolGuard } from "../../src/pi/tool-guard";

/** A minimal fake pi that captures the tool_call handler so a test can fire it. */
function fakePi() {
	let handler:
		| ((event: { toolName: string }) => Promise<ToolCallEventResult>)
		| undefined;
	return {
		on(event: string, h: (event: { toolName: string }) => Promise<never>) {
			if (event === "tool_call") handler = h as never;
		},
		call(toolName: string) {
			return handler?.({ toolName }) ?? Promise.resolve({});
		},
	};
}

describe("registerToolGuard", () => {
	it("is a no-op while the sandbox is inactive", async () => {
		const pi = fakePi();
		registerToolGuard(pi as never, {
			isActive: () => false,
			matcher: () => null,
		});
		expect(await pi.call("bash")).toEqual({});
	});

	it("allows whitelisted tools while active", async () => {
		const pi = fakePi();
		const matcher = createToolMatcher(["manager_reply", "manager_silent"]);
		registerToolGuard(pi as never, {
			isActive: () => true,
			matcher: () => matcher,
		});
		expect(await pi.call("manager_reply")).toEqual({});
	});

	it("blocks non-whitelisted tools while active and steers back", async () => {
		const pi = fakePi();
		const blocked: string[] = [];
		const matcher = createToolMatcher(["manager_reply", "manager_silent"]);
		registerToolGuard(pi as never, {
			isActive: () => true,
			matcher: () => matcher,
			onBlock: (name) => blocked.push(name),
		});
		const result = await pi.call("ask_user");
		expect(result.block).toBe(true);
		expect(result.reason).toContain("manager_reply");
		expect(blocked).toEqual(["ask_user"]);
	});
});
