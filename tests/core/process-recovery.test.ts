import { describe, expect, it } from "vitest";
import {
	type ProcessRecoveryDeps,
	stopProcess,
} from "../../src/core/process-recovery";

function setup() {
	let alive = true;
	let now = 0;
	const signals: string[] = [];
	const deps: ProcessRecoveryDeps = {
		isAlive: () => alive,
		signal: (_pid, signal) => {
			signals.push(signal);
			if (signal === "SIGTERM") alive = false;
		},
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	};
	return { deps, signals, setAlive: (value: boolean) => (alive = value) };
}

describe("stopProcess", () => {
	it("stops a live process gracefully", async () => {
		const { deps, signals } = setup();
		const result = await stopProcess(10, deps, { graceMs: 20, pollMs: 10 });

		expect(result).toMatchObject({ stopped: true, escalated: false });
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("escalates to SIGKILL when graceful shutdown does not finish", async () => {
		const { deps, signals, setAlive } = setup();
		deps.signal = (_pid, signal) => {
			signals.push(signal);
			if (signal === "SIGKILL") setAlive(false);
		};

		const result = await stopProcess(10, deps, { graceMs: 20, pollMs: 10 });

		expect(result).toMatchObject({ stopped: true, escalated: true });
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("does not claim recovery when both signals fail", async () => {
		const { deps } = setup();
		deps.signal = () => {
			throw new Error("permission denied");
		};

		const result = await stopProcess(10, deps, { graceMs: 20, pollMs: 10 });

		expect(result.stopped).toBe(false);
		expect(result.escalated).toBe(true);
		expect(result.error).toBeInstanceOf(Error);
	});
});
