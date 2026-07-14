/**
 * The order a turn READS in, end to end.
 *
 * Pi hands extension events over fire-and-forget, so each send races the sends behind
 * it. Uploading a tool's full-output log takes seconds; posting the answer that follows
 * takes milliseconds — so the answer went first, and the log landed under it, quoting a
 * card from further up the chat. The turn read back-to-front.
 *
 * This replays a real turn (tool card → its output file → the answer) against the real
 * ConnectController, with an upload deliberately slower than everything after it, and
 * pins the order the reader ends up seeing. Unqueued, the answer lands second and the
 * file last — that is the bug.
 */
import { describe, expect, it, vi } from "vitest";
import { AbortRegistry } from "../../../src/core/abort";
import { createSerialLane } from "../../../src/core/serial-lane";
import {
	ConnectController,
	type ConnectControllerDeps,
} from "../../../src/modes/connect/controller";
import { OutboundSender } from "../../../src/telegram/outbound";
import { FakeOutboundApi } from "../../helpers/fake-outbound-api";

const ALLOWED = 777;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A chat that records what lands in it, in the order it lands. `uploadMs` is how slow
 * the file upload is — the whole question is what happens to the messages behind it.
 */
function chat(uploadMs: number, uploadFails = false) {
	const landed: string[] = [];
	const uploadFile = vi.fn(async (input: { caption?: string }) => {
		await wait(uploadMs);
		if (uploadFails) throw new Error("file too large");
		landed.push(`file(${input.caption ?? ""})`);
	});
	const deps: ConnectControllerDeps = {
		allowedUserId: ALLOWED,
		maxBytes: 1000,
		isIdle: () => true,
		sendFollowUp: vi.fn(async () => {}),
		uploadFile,
		outbound: new OutboundSender(new FakeOutboundApi()),
		abort: new AbortRegistry(),
	};
	return { controller: new ConnectController(deps), landed, uploadFile };
}

describe("the order a turn lands in the chat", () => {
	it("a slow full-output upload is not overtaken by the answer behind it", async () => {
		const { controller, landed } = chat(30);
		const lane = createSerialLane();

		// Exactly what index.ts does, in the order Pi emits the events — each step queued
		// synchronously, which is what pins it to the place its event had.
		void lane.run(async () => {
			await controller.sendToolActivity({ toolName: "read" }, "call-1");
			landed.push("card(read)");
		});
		void lane.run(async () => {
			const cardId = await controller.completeToolActivity(
				"call-1",
				"…the file…",
				false,
			);
			landed.push("card-done(read)");
			await controller.attachToolOutput(
				"/logs/read-1.log",
				"full output",
				cardId,
			);
		});
		const answer = lane.run(async () => {
			await controller.deliverAssistant("Here is what the file says.");
			landed.push("answer");
		});

		await answer;
		await lane.drain();

		expect(landed).toEqual([
			"card(read)",
			"card-done(read)",
			"file(full output)",
			"answer",
		]);
	});

	it("hangs the file off its own card, not off whatever came last", async () => {
		const { controller, uploadFile } = chat(0);
		const lane = createSerialLane();

		await lane.run(() =>
			controller.sendToolActivity({ toolName: "bash" }, "call-9"),
		);
		await lane.run(async () => {
			const cardId = await controller.completeToolActivity(
				"call-9",
				"out",
				false,
			);
			await controller.attachToolOutput(
				"/logs/bash.log",
				"full output",
				cardId,
			);
		});
		await lane.drain();

		// The file replies to the card's OWN message id — which is the point of sending it
		// while that card is still the last thing in the chat.
		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/logs/bash.log",
				replyToMessageId: expect.any(Number),
			}),
		);
	});

	it("delivers a tool's log under the name it should arrive as", async () => {
		// The file on disk is the tool's own `/tmp/pi-bash-1.log`; what reaches the phone
		// must be a `.txt`, or it arrives as a blob the phone will not open.
		const { controller, uploadFile } = chat(0);
		const lane = createSerialLane();

		await lane.run(() =>
			controller.attachToolOutput(
				"/tmp/pi-bash-1.log",
				"full output",
				undefined,
				"bash-1700000000000.txt",
			),
		);

		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/tmp/pi-bash-1.log",
				filename: "bash-1700000000000.txt",
			}),
		);
	});

	it("one failed upload does not silence the answer behind it", async () => {
		const { controller, landed } = chat(0, true);
		const lane = createSerialLane();

		void lane
			.run(() => controller.attachToolOutput("/logs/huge.log", "full output"))
			.catch(() => {});
		await lane.run(async () => {
			await controller.deliverAssistant("Still here.");
			landed.push("answer");
		});

		expect(landed).toEqual(["answer"]);
	});
});
