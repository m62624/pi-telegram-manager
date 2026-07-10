import { describe, expect, it } from "vitest";
import { createPiSession, piSessionDir } from "../../src/pi/session";
import { FakeFs } from "../helpers/fake-fs";

describe("piSessionDir", () => {
	it("sanitizes the cwd into a --path-- session folder", () => {
		expect(piSessionDir("/agent", "/home/u/work")).toBe(
			"/agent/sessions/--home-u-work--",
		);
	});

	it("strips the leading slash and replaces separators and colons", () => {
		expect(piSessionDir("/agent", "/a/b:c")).toBe("/agent/sessions/--a-b-c--");
	});
});

describe("createPiSession", () => {
	const base = {
		agentDir: "/agent",
		cwd: "/home/u/work",
		now: new Date("2026-07-10T08:09:10.123Z"),
		sessionId: "fixed-id",
	};

	it("writes a v3 header file at the expected path", async () => {
		const fs = new FakeFs();
		const result = await createPiSession({ fs, ...base });

		expect(result.sessionDir).toBe("/agent/sessions/--home-u-work--");
		expect(result.sessionFile).toBe(
			"/agent/sessions/--home-u-work--/2026-07-10T08-09-10-123Z_fixed-id.jsonl",
		);
		expect(result.header).toEqual({
			type: "session",
			version: 3,
			id: "fixed-id",
			timestamp: "2026-07-10T08:09:10.123Z",
			cwd: "/home/u/work",
		});
	});

	it("persists exactly the header as a single JSON line", async () => {
		const fs = new FakeFs();
		const result = await createPiSession({ fs, ...base });
		const content = fs.files.get(result.sessionFile);
		expect(content).toBe(`${JSON.stringify(result.header)}\n`);
	});

	it("includes parentSession only when provided", async () => {
		const fs = new FakeFs();
		const withParent = await createPiSession({
			fs,
			...base,
			parentSession: "parent-1",
		});
		expect(withParent.header.parentSession).toBe("parent-1");

		const withoutParent = await createPiSession({
			fs,
			...base,
			parentSession: null,
		});
		expect(withoutParent.header).not.toHaveProperty("parentSession");
	});

	it("generates an id and timestamp when not supplied", async () => {
		const fs = new FakeFs();
		const result = await createPiSession({ fs, agentDir: "/agent", cwd: "/w" });
		expect(result.header.id).toMatch(/[0-9a-f-]{36}/);
		expect(result.header.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
	});
});
