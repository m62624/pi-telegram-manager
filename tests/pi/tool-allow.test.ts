import { describe, expect, it } from "vitest";
import { createToolMatcher } from "../../src/pi/tool-allow";

describe("createToolMatcher", () => {
	it("matches the fixed allowed names and rejects the rest", () => {
		const matcher = createToolMatcher(["manager_reply", "manager_silent"]);
		expect(matcher.matches("manager_reply")).toBe(true);
		expect(matcher.matches("manager_silent")).toBe(true);
		expect(matcher.matches("bash")).toBe(false);
		expect(matcher.matches("ask_user")).toBe(false);
	});

	it("anchors regex so 'read' does not match 'thread' or 'readfile'", () => {
		const matcher = createToolMatcher([], ["read"]);
		expect(matcher.matches("read")).toBe(true);
		expect(matcher.matches("thread")).toBe(false);
		expect(matcher.matches("readfile")).toBe(false);
	});

	it("supports wildcard patterns", () => {
		const matcher = createToolMatcher([], ["telegram_.*"]);
		expect(matcher.matches("telegram_attach")).toBe(true);
		expect(matcher.matches("telegram_message")).toBe(true);
		expect(matcher.matches("telegram")).toBe(false);
	});

	it("warns and skips an invalid pattern instead of throwing", () => {
		const warnings: string[] = [];
		const matcher = createToolMatcher(["manager_reply"], ["("], (message) =>
			warnings.push(message),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("allowedTools");
		// The valid fixed name still works.
		expect(matcher.matches("manager_reply")).toBe(true);
	});
});
