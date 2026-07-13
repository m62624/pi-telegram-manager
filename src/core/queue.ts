/**
 * Ordered queue of pending prompt turns, split into priority lanes.
 *
 * Incoming Telegram messages can arrive while the agent is busy; they are
 * enqueued and dispatched one at a time when the agent goes idle. Three lanes
 * order dispatch: `control` (interrupts like /abort, /stop) drains before
 * `priority`, which drains before `default`; within a lane it is FIFO.
 *
 * A queued turn remembers the Telegram `sourceMessageIds` it was built from, so
 * that editing one of those messages before it is dispatched rewrites the
 * queued text (`editBySource`) instead of adding a duplicate turn.
 *
 * This is a pure data structure — it only orders and mutates items. The
 * idle/pending gating that decides *when* to pull the next turn lives in the
 * controllers, which call `peek`/`dequeue`.
 */

/** Lanes in descending dispatch priority. */
export type QueueLane = "control" | "priority" | "default";

const LANE_ORDER: readonly QueueLane[] = ["control", "priority", "default"];

export interface QueueItem {
	id: string;
	lane: QueueLane;
	text: string;
	/** Inline images (base64 + mimeType) that rode along with this turn. */
	images?: Array<{ data: string; mimeType: string }>;
	/** Telegram message ids this turn was assembled from (for edit/remove). */
	sourceMessageIds: number[];
}

export class MessageQueue {
	private readonly lanes: Record<QueueLane, QueueItem[]> = {
		control: [],
		priority: [],
		default: [],
	};

	/** Append an item to the back of its lane. */
	enqueue(item: QueueItem): void {
		this.lanes[item.lane].push(item);
	}

	/** The next item to dispatch (highest-priority, FIFO) without removing it. */
	peek(): QueueItem | undefined {
		for (const lane of LANE_ORDER) {
			if (this.lanes[lane].length > 0) return this.lanes[lane][0];
		}
		return undefined;
	}

	/** Remove and return the next item to dispatch, or undefined when empty. */
	dequeue(): QueueItem | undefined {
		for (const lane of LANE_ORDER) {
			const item = this.lanes[lane].shift();
			if (item) return item;
		}
		return undefined;
	}

	/**
	 * Rewrite the text of the first queued turn built from `messageId`. Returns
	 * true if a matching turn was found (i.e. it was still queued, not yet
	 * dispatched).
	 */
	editBySource(messageId: number, text: string): boolean {
		const item = this.findBySource(messageId);
		if (!item) return false;
		item.text = text;
		return true;
	}

	/**
	 * Fold another Telegram message into a queued turn: append its text (when it adds
	 * anything), its images, and its message id. Used for an ALBUM, which Telegram
	 * delivers as one message per photo — they belong to a single turn. Returns false
	 * when that turn is already gone (dispatched), so the caller can enqueue instead.
	 */
	appendToItem(
		id: string,
		part: {
			text?: string;
			images?: Array<{ data: string; mimeType: string }>;
			sourceMessageId: number;
		},
	): boolean {
		const item = this.findById(id);
		if (!item) return false;
		const text = part.text?.trim();
		if (text) item.text = item.text ? `${item.text}\n\n${text}` : text;
		if (part.images && part.images.length > 0) {
			item.images = [...(item.images ?? []), ...part.images];
		}
		item.sourceMessageIds.push(part.sourceMessageId);
		return true;
	}

	private findById(id: string): QueueItem | undefined {
		for (const lane of LANE_ORDER) {
			const item = this.lanes[lane].find((entry) => entry.id === id);
			if (item) return item;
		}
		return undefined;
	}

	/** Remove the first queued turn built from `messageId`. Returns true if removed. */
	removeBySource(messageId: number): boolean {
		for (const lane of LANE_ORDER) {
			const list = this.lanes[lane];
			const index = list.findIndex((item) =>
				item.sourceMessageIds.includes(messageId),
			);
			if (index !== -1) {
				list.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	private findBySource(messageId: number): QueueItem | undefined {
		for (const lane of LANE_ORDER) {
			const item = this.lanes[lane].find((entry) =>
				entry.sourceMessageIds.includes(messageId),
			);
			if (item) return item;
		}
		return undefined;
	}

	/** Total queued items across all lanes. */
	size(): number {
		return (
			this.lanes.control.length +
			this.lanes.priority.length +
			this.lanes.default.length
		);
	}

	isEmpty(): boolean {
		return this.size() === 0;
	}

	/** Discard everything. */
	clear(): void {
		this.lanes.control.length = 0;
		this.lanes.priority.length = 0;
		this.lanes.default.length = 0;
	}

	/** Items in dispatch order — for status/debug display. */
	snapshot(): QueueItem[] {
		return LANE_ORDER.flatMap((lane) => this.lanes[lane]);
	}
}
