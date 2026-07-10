import { describe, expect, it } from "vitest";
import { MessageQueue, type QueueItem } from "../../src/core/queue";

function item(
	overrides: Partial<QueueItem> & Pick<QueueItem, "id">,
): QueueItem {
	return {
		lane: "default",
		text: overrides.id,
		sourceMessageIds: [],
		...overrides,
	};
}

describe("MessageQueue ordering", () => {
	it("is FIFO within a lane", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "a" }));
		q.enqueue(item({ id: "b" }));
		expect(q.dequeue()?.id).toBe("a");
		expect(q.dequeue()?.id).toBe("b");
		expect(q.dequeue()).toBeUndefined();
	});

	it("drains control before priority before default", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "d", lane: "default" }));
		q.enqueue(item({ id: "p", lane: "priority" }));
		q.enqueue(item({ id: "c", lane: "control" }));
		expect(q.snapshot().map((i) => i.id)).toEqual(["c", "p", "d"]);
		expect(q.dequeue()?.id).toBe("c");
		expect(q.dequeue()?.id).toBe("p");
		expect(q.dequeue()?.id).toBe("d");
	});

	it("peek returns the next item without removing it", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "a" }));
		expect(q.peek()?.id).toBe("a");
		expect(q.size()).toBe(1);
	});
});

describe("MessageQueue edit/remove by source", () => {
	it("rewrites a queued turn built from an edited message", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "a", text: "old", sourceMessageIds: [10, 11] }));
		expect(q.editBySource(11, "new")).toBe(true);
		expect(q.peek()?.text).toBe("new");
	});

	it("returns false when the source is not queued (already dispatched)", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "a", sourceMessageIds: [10] }));
		expect(q.editBySource(99, "new")).toBe(false);
	});

	it("removes a queued turn by source", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "a", sourceMessageIds: [10] }));
		q.enqueue(item({ id: "b", sourceMessageIds: [20] }));
		expect(q.removeBySource(10)).toBe(true);
		expect(q.snapshot().map((i) => i.id)).toEqual(["b"]);
		expect(q.removeBySource(10)).toBe(false);
	});

	it("edits the highest-priority match first", () => {
		const q = new MessageQueue();
		q.enqueue(item({ id: "d", lane: "default", sourceMessageIds: [7] }));
		q.enqueue(item({ id: "c", lane: "control", sourceMessageIds: [7] }));
		q.editBySource(7, "changed");
		expect(q.snapshot().find((i) => i.text === "changed")?.id).toBe("c");
	});
});

describe("MessageQueue bookkeeping", () => {
	it("tracks size, emptiness, and clears", () => {
		const q = new MessageQueue();
		expect(q.isEmpty()).toBe(true);
		q.enqueue(item({ id: "a", lane: "control" }));
		q.enqueue(item({ id: "b", lane: "default" }));
		expect(q.size()).toBe(2);
		q.clear();
		expect(q.isEmpty()).toBe(true);
		expect(q.dequeue()).toBeUndefined();
	});
});
