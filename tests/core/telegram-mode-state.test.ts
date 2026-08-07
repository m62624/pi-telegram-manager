import { describe, expect, it } from "vitest";
import {
	activeTelegramMode,
	hasManagerRuntime,
	hasPersonalRuntime,
} from "../../src/core/telegram-mode-state";

const none = {
	manager: false,
	managerClient: false,
	connect: false,
	client: false,
	mixed: false,
};

describe("telegram runtime mode state", () => {
	it.each([
		["manager", { ...none, manager: true }],
		["mixed", { ...none, manager: true, connect: true, mixed: true }],
		["personal", { ...none, connect: true, client: true }],
		["stop", none],
	] as const)("identifies %s", (expected, state) => {
		expect(activeTelegramMode(state)).toBe(expected);
	});

	it("keeps partially started clients recoverable", () => {
		expect(hasManagerRuntime({ ...none, managerClient: true })).toBe(true);
		expect(hasPersonalRuntime({ ...none, client: true })).toBe(true);
		expect(activeTelegramMode({ ...none, managerClient: true })).toBe(
			"manager",
		);
		expect(activeTelegramMode({ ...none, client: true })).toBe("personal");
	});

	it("prioritizes mixed over its two component resources", () => {
		expect(
			activeTelegramMode({
				...none,
				managerClient: true,
				client: true,
				mixed: true,
			}),
		).toBe("mixed");
	});
});
