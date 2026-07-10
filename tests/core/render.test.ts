import { describe, expect, it } from "vitest";
import { applyLabeler, renderReply } from "../../src/core/render";

describe("applyLabeler", () => {
	it("prepends the label as a first line", () => {
		expect(applyLabeler("hi", "LLM agent:")).toBe("LLM agent:\nhi");
	});

	it("adds nothing for an empty or whitespace label", () => {
		expect(applyLabeler("hi", "")).toBe("hi");
		expect(applyLabeler("hi", "   ")).toBe("hi");
		expect(applyLabeler("hi")).toBe("hi");
	});

	it("does not double-apply a label already present", () => {
		expect(applyLabeler("LLM agent:\nhi", "LLM agent:")).toBe("LLM agent:\nhi");
		expect(applyLabeler("LLM agent:", "LLM agent:")).toBe("LLM agent:");
	});
});

describe("renderReply", () => {
	it("trims the reply and applies the labeler", () => {
		expect(renderReply("  hello  ", { labeler: "Bot:" })).toEqual({
			markdown: "Bot:\nhello",
		});
	});

	it("returns the plain reply without a labeler", () => {
		expect(renderReply("hello")).toEqual({ markdown: "hello" });
	});
});
