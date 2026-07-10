import { describe, expect, it, vi } from "vitest";
import {
	type AttachmentToolDeps,
	createAttachmentTools,
	TELEGRAM_TOOL_NAMES,
} from "../../src/core/attachments";

function tools(overrides: Partial<AttachmentToolDeps> = {}) {
	const deps: AttachmentToolDeps = {
		sendMessage: vi.fn(async () => {}),
		sendAttachment: vi.fn(async () => {}),
		...overrides,
	};
	const list = createAttachmentTools(deps);
	const byName = Object.fromEntries(list.map((tool) => [tool.name, tool]));
	const run = (name: string, params: Record<string, unknown>) =>
		byName[name].execute(
			"id",
			params as never,
			undefined,
			undefined,
			{} as never,
		);
	return { deps, run };
}

describe("createAttachmentTools", () => {
	it("registers exactly the gated tool names", () => {
		const names = createAttachmentTools({
			sendMessage: async () => {},
			sendAttachment: async () => {},
		}).map((t) => t.name);
		expect(names).toEqual([...TELEGRAM_TOOL_NAMES]);
	});
});

describe("telegram_message", () => {
	it("sends trimmed text and reports success", async () => {
		const { deps, run } = tools();
		const result = await run("telegram_message", { text: "  hi  " });
		expect(deps.sendMessage).toHaveBeenCalledWith("hi");
		expect(result.content[0].text).toContain("sent");
		expect(result.isError).toBeUndefined();
	});

	it("rejects empty text without sending", async () => {
		const { deps, run } = tools();
		const result = await run("telegram_message", { text: "   " });
		expect(result.isError).toBe(true);
		expect(deps.sendMessage).not.toHaveBeenCalled();
	});
});

describe("telegram_attach", () => {
	it("sends a file by path with a trimmed caption", async () => {
		const { deps, run } = tools();
		const result = await run("telegram_attach", {
			path: " /a.png ",
			caption: " look ",
		});
		expect(deps.sendAttachment).toHaveBeenCalledWith({
			path: "/a.png",
			url: undefined,
			caption: "look",
		});
		expect(result.isError).toBeUndefined();
	});

	it("sends a file by url with no caption", async () => {
		const { deps, run } = tools();
		await run("telegram_attach", { url: "https://x/f.pdf" });
		expect(deps.sendAttachment).toHaveBeenCalledWith({
			path: undefined,
			url: "https://x/f.pdf",
			caption: undefined,
		});
	});

	it("rejects when neither path nor url is given", async () => {
		const { deps, run } = tools();
		const result = await run("telegram_attach", { caption: "x" });
		expect(result.isError).toBe(true);
		expect(deps.sendAttachment).not.toHaveBeenCalled();
	});

	it("rejects when both path and url are given", async () => {
		const { deps, run } = tools();
		const result = await run("telegram_attach", {
			path: "/a",
			url: "https://x",
		});
		expect(result.isError).toBe(true);
		expect(deps.sendAttachment).not.toHaveBeenCalled();
	});
});
