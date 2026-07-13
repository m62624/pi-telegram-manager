import { describe, expect, it } from "vitest";
import { managerBannerLines } from "../../src/ui/manager-banner";

describe("managerBannerLines", () => {
	it("warns and summarises the manager status", () => {
		const lines = managerBannerLines({
			activeChat: "42",
			queued: 3,
		});
		expect(lines[0]).toContain("MANAGER");
		expect(lines[1]).toContain("active: 42");
		expect(lines[1]).toContain("queued: 3");
		expect(lines[2]).toContain("/telegram-stop");
	});

	it("shows idle when no chat is active", () => {
		const lines = managerBannerLines({ queued: 0 });
		expect(lines[1]).toContain("idle");
	});

	it("shows chats held in the owner-reply window", () => {
		const lines = managerBannerLines({
			queued: 0,
			holding: 2,
		});
		expect(lines[1]).toContain("holding: 2");
	});

	it("omits holding when zero to keep the idle banner clean", () => {
		const lines = managerBannerLines({
			queued: 0,
			holding: 0,
		});
		expect(lines[1]).not.toContain("holding");
	});
});
