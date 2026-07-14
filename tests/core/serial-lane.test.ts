import { describe, expect, it } from "vitest";
import { createSerialLane } from "../../src/core/serial-lane";

/** A promise plus the handles to settle it later — a task we control the timing of. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createSerialLane", () => {
	it("runs tasks one at a time, in the order they were queued", async () => {
		const lane = createSerialLane();
		const started: string[] = [];
		const slow = deferred();

		// This is the live bug in miniature: a slow upload queued first, a fast send
		// queued second. Unordered, the fast one wins and the chat reads back-to-front.
		const first = lane.run(async () => {
			started.push("slow");
			await slow.promise;
		});
		const second = lane.run(async () => {
			started.push("fast");
		});

		await Promise.resolve();
		expect(started).toEqual(["slow"]); // the second task has not even begun

		slow.resolve();
		await Promise.all([first, second]);
		expect(started).toEqual(["slow", "fast"]);
	});

	it("keeps going after a task fails, and hands the failure back to its caller", async () => {
		const lane = createSerialLane();
		const done: string[] = [];

		const failed = lane.run(async () => {
			throw new Error("upload refused");
		});
		const after = lane.run(async () => {
			done.push("answer");
		});

		await expect(failed).rejects.toThrow("upload refused");
		await after;
		// One failed upload must never silence the answer behind it.
		expect(done).toEqual(["answer"]);
	});

	it("drains everything queued so far", async () => {
		const lane = createSerialLane();
		const gate = deferred();
		const done: string[] = [];

		void lane.run(async () => {
			await gate.promise;
			done.push("card");
		});
		void lane
			.run(async () => {
				done.push("file");
			})
			.catch(() => {});

		const drained = lane.drain();
		gate.resolve();
		await drained;
		expect(done).toEqual(["card", "file"]);
	});

	it("drain resolves even when a queued task rejected", async () => {
		const lane = createSerialLane();
		lane
			.run(async () => {
				throw new Error("boom");
			})
			.catch(() => {});
		await expect(lane.drain()).resolves.toBeUndefined();
	});

	it("counts the work still to come, and forgets it once it is done", async () => {
		const lane = createSerialLane();
		expect(lane.pending()).toBe(0);

		const gate = deferred();
		const first = lane.run(() => gate.promise);
		const second = lane.run(async () => {});
		// Two queued: the answer knows it is not the only thing waiting to be sent.
		expect(lane.pending()).toBe(2);

		gate.resolve();
		await Promise.all([first, second]);
		expect(lane.pending()).toBe(0);
	});
});
