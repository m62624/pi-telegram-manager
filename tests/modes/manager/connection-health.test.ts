import { describe, expect, it } from "vitest";
import { connectionAlerts } from "../../../src/modes/manager/connection-health";

const live = { canReply: true, isEnabled: true };

describe("connectionAlerts", () => {
	it("says nothing about a connection it is seeing for the first time", () => {
		// Startup diagnostics already report the state; repeating it here would
		// double every message the owner gets.
		expect(connectionAlerts(null, live)).toEqual([]);
		expect(
			connectionAlerts(null, { canReply: false, isEnabled: false }),
		).toEqual([]);
	});

	it("says nothing when nothing changed", () => {
		expect(connectionAlerts(live, live)).toEqual([]);
		expect(
			connectionAlerts(
				{ canReply: false, isEnabled: true },
				{ canReply: false, isEnabled: true },
			),
		).toEqual([]);
	});

	it("reports a revoked reply right — the failure nobody can see from inside", () => {
		expect(
			connectionAlerts(live, { canReply: false, isEnabled: true }),
		).toEqual(["reply_right_lost"]);
	});

	it("treats an unknown-then-revoked right as a real loss", () => {
		// Stored before the field existed, then explicitly taken away.
		expect(
			connectionAlerts(
				{ canReply: undefined, isEnabled: true },
				{ canReply: false, isEnabled: true },
			),
		).toEqual(["reply_right_lost"]);
	});

	it("does not read missing news as good news", () => {
		// false → undefined is an update that says nothing about rights, not a fix.
		expect(
			connectionAlerts(
				{ canReply: false, isEnabled: true },
				{ canReply: undefined, isEnabled: true },
			),
		).toEqual([]);
	});

	it("reports a restored reply right", () => {
		expect(
			connectionAlerts({ canReply: false, isEnabled: true }, live),
		).toEqual(["reply_right_restored"]);
	});

	it("reports only the disconnect when the connection goes off", () => {
		// A revoked right is academic while the bot receives nothing at all: two
		// alarms for one action is noise.
		expect(
			connectionAlerts(live, { canReply: false, isEnabled: false }),
		).toEqual(["disabled"]);
	});

	it("reports a connection coming back, with its right restored in the same update", () => {
		expect(
			connectionAlerts({ canReply: false, isEnabled: false }, live),
		).toEqual(["enabled", "reply_right_restored"]);
	});
});
