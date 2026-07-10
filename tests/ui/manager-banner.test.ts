import { describe, expect, it } from "vitest";
import { managerBannerLines } from "../../src/ui/manager-banner";

describe("managerBannerLines", () => {
	it("warns and summarises the manager status", () => {
		const lines = managerBannerLines({
			subMode: "takeover",
			activeChat: "42",
			queued: 3,
		});
		expect(lines[0]).toContain("MANAGER");
		expect(lines[1]).toContain("takeover");
		expect(lines[1]).toContain("active: 42");
		expect(lines[1]).toContain("queued: 3");
		expect(lines[2]).toContain("/telegram-manager-stop");
	});

	it("shows idle when no chat is active", () => {
		const lines = managerBannerLines({ subMode: "observer", queued: 0 });
		expect(lines[1]).toContain("idle");
	});
});
