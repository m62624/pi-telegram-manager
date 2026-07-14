import { describe, expect, it } from "vitest";
import {
	comparePayloads,
	describePayload,
	fingerprint,
	PrefixWatch,
} from "../../src/core/payload-probe";

/** A payload as a llama.cpp server is handed one (openai-completions shape). */
const payload = (tools: string[], userText = "hi") => ({
	model: "local-model",
	messages: [
		{ role: "system", content: "You are an agent. Rules follow.".repeat(20) },
		{ role: "user", content: userText },
	],
	stream: true,
	...(tools.length > 0
		? {
				tools: tools.map((name) => ({
					type: "function",
					function: { name, parameters: { type: "object" } },
				})),
			}
		: {}),
});

describe("describePayload", () => {
	it("reads the head: the system prompt AND the tool schemas", () => {
		// On a local backend the chat template renders the tool list INTO the system
		// message, so the tools are not a footnote at the end of the prompt — they are at
		// the front of it, ahead of every word anyone has said.
		const shape = describePayload(payload(["read", "bash"]));
		expect(shape.toolNames).toEqual(["read", "bash"]);
		expect(shape.toolChars).toBeGreaterThan(0);
		// The head is BOTH: the system prompt and the schemas. Measuring only the prompt
		// would have missed the live bug entirely — what vanished there was the tools.
		expect(shape.headChars).toBeGreaterThan(shape.toolChars);
		expect(shape.headChars).toBeGreaterThan(600);
		expect(shape.messages).toBe(1); // the system message is head, not conversation
	});

	it("counts an empty tool list as no bytes, because that is what is sent", () => {
		// A payload with no tools omits the key entirely — it does not send `"tools": []`.
		// A probe that scored it as two characters would report a head change every time a
		// memory pass ended, and cry wolf on the one thing that is working correctly.
		expect(describePayload(payload([])).toolChars).toBe(0);
		expect(describePayload(undefined).headChars).toBe(0);
	});

	it("survives a payload that is not one", () => {
		expect(describePayload({ messages: "nonsense" }).messages).toBe(0);
		expect(describePayload({ tools: [{}, 7] }).toolNames).toEqual(["?", "?"]);
	});

	it("reads an Anthropic-shaped payload too (system in a field of its own)", () => {
		const shape = describePayload({
			system: "rules",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "read" }],
		});
		expect(shape.toolNames).toEqual(["read"]);
		expect(shape.headChars).toBeGreaterThan(5);
		expect(shape.messages).toBe(1);
	});
});

describe("fingerprint", () => {
	it("is equal exactly when the bytes are", () => {
		expect(fingerprint("abc")).toBe(fingerprint("abc"));
		expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
		// Length is part of it, so a collision cannot be a different-length string.
		expect(fingerprint("abc")).toContain(":3");
	});
});

describe("comparePayloads", () => {
	it("names the tools that came and went", () => {
		const delta = comparePayloads(
			describePayload(payload(["read", "bash", "write"])),
			describePayload(payload(["read", "manager_reply"])),
		);
		expect(delta.headStable).toBe(false);
		expect(delta.toolsRemoved).toEqual(["bash", "write"]);
		expect(delta.toolsAdded).toEqual(["manager_reply"]);
		expect(delta.headCharsDelta).toBeLessThan(0);
	});

	it("calls a head stable when only the conversation grew", () => {
		// The good case, and the only one a prefix cache rewards: everything new is at the
		// END. The backend re-reads the new message and nothing else.
		const delta = comparePayloads(
			describePayload(payload(["read"], "hi")),
			describePayload(payload(["read"], "hi, and then some more")),
		);
		expect(delta.headStable).toBe(true);
		expect(delta.toolsAdded).toEqual([]);
		expect(delta.toolsRemoved).toEqual([]);
	});
});

describe("PrefixWatch", () => {
	it("does not call the first request of a run a mid-run churn", () => {
		// A run may legitimately open with a different head — a mode switch really does
		// change which tools exist. What it may not do is change it AFTER it has started.
		const watch = new PrefixWatch();
		watch.runStarted();
		expect(watch.record(payload(["read", "bash"]))).toBeNull(); // nothing to compare

		watch.runStarted();
		const churn = watch.record(payload(["manager_reply"]));
		expect(churn?.midRun).toBe(false);
		expect(watch.defects()).toHaveLength(0);
	});

	it("catches a STRANGER changing the head between two calls of ONE run", () => {
		// The live bug this file exists for. Two consecutive calls inside one turn:
		//     prefill=    97  cached=24 348   → called bash ×2
		//     prefill=11 653  cached=     0   → called bash
		// The cache went to zero and the prompt HALVED while the conversation GREW. Nothing
		// about the model's situation had changed. Only the tool list had — and not by us:
		// what reached the model is not what we set.
		const watch = new PrefixWatch();
		const ours = ["read", "bash", "write", "grep"];
		watch.runStarted();
		watch.record(payload(ours), ours);
		const churn = watch.record(payload(["read", "bash"], "hi, and more"), ours);

		expect(churn).not.toBeNull();
		expect(churn?.midRun).toBe(true);
		expect(churn?.foreign).toBe(true);
		expect(churn?.delta.toolsRemoved).toEqual(["write", "grep"]);
		expect(churn?.delta.headCharsDelta).toBeLessThan(0);
		expect(watch.defects()).toHaveLength(1);
	});

	it("does not report OUR OWN mid-run change as an intrusion", () => {
		// A finished memory pass withdraws its probes — deliberately, because a pass that
		// can still see step one's tool will call step one again. That rewrites the head
		// and costs the cache, and we knew it when we wrote it. Reported as a defect, it
		// woke the owner once per memory pass with a warning about ourselves.
		const watch = new PrefixWatch();
		watch.runStarted();
		const probes = ["manager_identify", "manager_candidates", "manager_verify"];
		watch.record(payload(probes), probes);
		const churn = watch.record(payload([]), []); // the pass is done: no tools left

		expect(churn?.midRun).toBe(true);
		expect(churn?.foreign).toBe(false);
		expect(churn?.delta.toolsRemoved).toEqual(probes);
		// It happened, and history says so. It is simply not somebody else's doing.
		expect(watch.history()).toHaveLength(1);
		expect(watch.defects()).toHaveLength(0);
	});

	it("accuses nobody when it does not know whose list it is", () => {
		// Before the first refresh we have written nothing, so we can claim nothing — and
		// an alarm that fires on what it cannot attribute is an alarm that fires on noise.
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload(["read", "bash"]), null);
		const churn = watch.record(payload(["read"]), null);
		expect(churn?.foreign).toBe(false);
		expect(watch.defects()).toHaveLength(0);
	});

	it("does not care about the ORDER we set the tools in, only which ones arrived", () => {
		// Pi builds the payload from its own registry; the list is ours whether or not it
		// comes back in the order we handed it over.
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload(["read", "bash"]), ["read", "bash"]);
		const churn = watch.record(payload(["read"], "more"), ["bash", "read"]);
		expect(churn?.foreign).toBe(true); // "read" alone is not {read, bash}
		expect(
			watch.record(payload(["bash", "read"], "more"), ["read", "bash"])
				?.foreign,
		).toBe(false);
	});

	it("says nothing at all while the head holds", () => {
		const watch = new PrefixWatch();
		watch.runStarted();
		watch.record(payload(["read"], "one"));
		expect(watch.record(payload(["read"], "one two"))).toBeNull();
		expect(watch.record(payload(["read"], "one two three"))).toBeNull();
		expect(watch.history()).toHaveLength(0);
		expect(watch.current()?.messages).toBe(1);
	});

	it("keeps only the newest churns — the ones anybody reads", () => {
		const watch = new PrefixWatch(() => 0, 2);
		watch.runStarted();
		for (const tools of [["a"], ["b"], ["c"], ["d"]]) {
			watch.record(payload(tools));
		}
		expect(watch.history()).toHaveLength(2);
		expect(watch.history()[0].delta.toolsAdded).toEqual(["d"]);
	});
});
