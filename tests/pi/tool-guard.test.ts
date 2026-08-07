import { describe, expect, it } from "vitest";
import type { ToolCallEventResult } from "../../src/pi/sdk";
import { createToolMatcher } from "../../src/pi/tool-allow";
import {
	CONSOLIDATION_END_TURN_HINT,
	RESOLVE_DRAFT_END_TURN_HINT,
	registerToolGuard,
} from "../../src/pi/tool-guard";

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

	it("steers a blocked decision tool at the resolve tool on a revise turn", async () => {
		// Regression: the steer used to be static, so blocking manager_reply on a
		// revise turn answered "call manager_reply" — a contradiction that burned
		// the turn while a ready draft sat held.
		const pi = fakePi();
		const matcher = createToolMatcher(["manager_resolve_draft"]);
		registerToolGuard(pi as never, {
			isActive: () => true,
			matcher: () => matcher,
			endTurnHint: () => RESOLVE_DRAFT_END_TURN_HINT,
		});
		const result = await pi.call("manager_reply");
		expect(result.block).toBe(true);
		expect(result.reason).toContain("manager_resolve_draft");
		expect(result.reason).toContain("disabled this turn");
	});

	it("never steers a blocked silent call back to reply tools during consolidation", async () => {
		const pi = fakePi();
		const matcher = createToolMatcher([
			"manager_remember",
			"manager_recall",
			"manager_revise",
			"manager_forget",
			"manager_done",
		]);
		registerToolGuard(pi as never, {
			isActive: () => true,
			matcher: () => matcher,
			endTurnHint: () => CONSOLIDATION_END_TURN_HINT,
		});
		const result = await pi.call("manager_silent");
		expect(result.block).toBe(true);
		expect(result.reason).toContain("background memory pass");
		expect(result.reason).toContain(
			"manager_reply / manager_silent do not exist",
		);
		expect(result.reason).not.toContain(
			"End your turn by calling exactly one of manager_reply",
		);
	});
});
