import { describe, expect, it } from "vitest";
import { ManualClock } from "../../../src/core/timers";
import {
	botMayReply,
	TakeoverMachine,
} from "../../../src/modes/manager/submode";

function setup(ownerReplyWindowMs = 300_000) {
	const clock = new ManualClock(0);
	const machine = new TakeoverMachine({ ownerReplyWindowMs, clock });
	return { clock, machine };
}

describe("TakeoverMachine", () => {
	it("starts bot_active and lets the bot reply", () => {
		const { machine } = setup();
		expect(machine.stateOf("c")).toBe("bot_active");
		expect(botMayReply("takeover", machine, "c")).toBe(true);
	});

	it("freezes when the owner types manually", () => {
		const { machine } = setup();
		machine.onOwnerMessage("c");
		expect(machine.isFrozen("c")).toBe(true);
		expect(botMayReply("takeover", machine, "c")).toBe(false);
	});

	it("re-engages the bot if the owner stays silent past the window", () => {
		const { clock, machine } = setup();
		machine.onOwnerMessage("c"); // frozen
		machine.onInterlocutorMessage("c"); // arms owner-reply window
		clock.advance(300_001);
		expect(machine.onTick()).toEqual(["c"]);
		expect(machine.isFrozen("c")).toBe(false);
	});

	it("stays frozen when the owner answers within the window", () => {
		const { clock, machine } = setup();
		machine.onOwnerMessage("c");
		machine.onInterlocutorMessage("c"); // arms window
		clock.advance(200_000);
		machine.onOwnerMessage("c"); // owner answered → cancels window, re-freezes
		clock.advance(200_000);
		expect(machine.onTick()).toEqual([]);
		expect(machine.isFrozen("c")).toBe(true);
	});

	it("does not arm a window for an interlocutor message while active", () => {
		const { clock, machine } = setup();
		machine.onInterlocutorMessage("c"); // active → no-op
		clock.advance(300_001);
		expect(machine.onTick()).toEqual([]);
		expect(machine.isFrozen("c")).toBe(false);
	});

	it("isolates state per chat and forgets on remove", () => {
		const { machine } = setup();
		machine.onOwnerMessage("a");
		expect(machine.isFrozen("a")).toBe(true);
		expect(machine.isFrozen("b")).toBe(false);
		machine.remove("a");
		expect(machine.isFrozen("a")).toBe(false);
	});
});

describe("botMayReply", () => {
	it("always allows a reply in observer mode", () => {
		const { machine } = setup();
		machine.onOwnerMessage("c"); // frozen, but observer ignores freezing
		expect(botMayReply("observer", machine, "c")).toBe(true);
	});
});
