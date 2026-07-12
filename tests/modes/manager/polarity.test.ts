import { describe, expect, it } from "vitest";
import {
	managerGuardActive,
	managerHoldsSession,
	mixedContextSource,
	type Polarity,
} from "../../../src/modes/manager/polarity";

const POLARITIES: Polarity[] = ["coding", "telegram"];

describe("managerHoldsSession", () => {
	it("non-mixed manager always holds the session, regardless of polarity", () => {
		for (const p of POLARITIES) {
			expect(managerHoldsSession(false, p)).toBe(true);
		}
	});

	it("mixed holds the session only in the telegram polarity", () => {
		expect(managerHoldsSession(true, "coding")).toBe(false);
		expect(managerHoldsSession(true, "telegram")).toBe(true);
	});
});

describe("managerGuardActive (tool sandbox enforcement)", () => {
	it("never active when the manager is not running", () => {
		for (const p of POLARITIES) {
			expect(managerGuardActive(false, false, p)).toBe(false);
			expect(managerGuardActive(false, true, p)).toBe(false);
		}
	});

	it("standalone manager: active whenever running", () => {
		for (const p of POLARITIES) {
			expect(managerGuardActive(true, false, p)).toBe(true);
		}
	});

	it("mixed: active only in the telegram polarity, so coding keeps full tools", () => {
		expect(managerGuardActive(true, true, "coding")).toBe(false);
		expect(managerGuardActive(true, true, "telegram")).toBe(true);
	});
});

describe("mixedContextSource", () => {
	it("no manager running → context untouched", () => {
		for (const p of POLARITIES) {
			expect(mixedContextSource(false, false, p)).toBe("untouched");
		}
	});

	it("standalone manager → the active chat's isolated history", () => {
		for (const p of POLARITIES) {
			expect(mixedContextSource(true, false, p)).toBe("manager-chat");
		}
	});

	it("mixed telegram polarity → the active chat's isolated history", () => {
		expect(mixedContextSource(true, true, "telegram")).toBe("manager-chat");
	});

	it("mixed coding polarity → the filtered coding thread", () => {
		expect(mixedContextSource(true, true, "coding")).toBe("coding-filtered");
	});
});

describe("switching is deadlock-free: the derived state is a pure function", () => {
	// For every reachable (managerRunning, mixedActive, polarity) the three
	// derivations agree — the guard is active exactly when the manager holds the
	// session and is running, and the context source follows the same predicate.
	it("guard-active and manager-chat context agree with managerHoldsSession", () => {
		for (const managerRunning of [false, true]) {
			for (const mixedActive of [false, true]) {
				for (const p of POLARITIES) {
					const holds = managerHoldsSession(mixedActive, p);
					expect(managerGuardActive(managerRunning, mixedActive, p)).toBe(
						managerRunning && holds,
					);
					const source = mixedContextSource(managerRunning, mixedActive, p);
					if (managerRunning || mixedActive) {
						expect(source).toBe(holds ? "manager-chat" : "coding-filtered");
					} else {
						expect(source).toBe("untouched");
					}
				}
			}
		}
	});
});
