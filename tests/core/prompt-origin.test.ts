import { describe, expect, it } from "vitest";
import {
	classifyInputSource,
	shouldMirrorToTelegram,
} from "../../src/core/prompt-origin";

describe("classifyInputSource", () => {
	it("maps Pi input sources to provenance categories", () => {
		expect(classifyInputSource("interactive")).toBe("terminal");
		expect(classifyInputSource("rpc")).toBe("programmatic");
		expect(classifyInputSource("extension")).toBe("external");
		expect(classifyInputSource("anything-else")).toBe("external");
	});
});

describe("shouldMirrorToTelegram", () => {
	it("mirrors only terminal-typed prompts", () => {
		expect(shouldMirrorToTelegram("terminal")).toBe(true);
		expect(shouldMirrorToTelegram("telegram")).toBe(false);
		expect(shouldMirrorToTelegram("external")).toBe(false);
		expect(shouldMirrorToTelegram("programmatic")).toBe(false);
	});

	it("does not mirror our own extension-injected (Telegram) messages", () => {
		// A Telegram message we inject arrives as source "extension" → "external".
		expect(shouldMirrorToTelegram(classifyInputSource("extension"))).toBe(
			false,
		);
	});
});
