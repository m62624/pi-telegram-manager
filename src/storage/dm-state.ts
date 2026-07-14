/**
 * The state of the owner's DM with their bot: which threads we opened in it, and which
 * messages we pinned to it.
 *
 * `topics.json` and `mode-pin.json` were both answering the same question — "what have
 * we put in the owner's chat, and where is it?" — and both were read at start and
 * rewritten by the same events. They are one file now.
 *
 * The store is generic over the topics blob on purpose: `storage/` knows how to keep a
 * record safely and nothing about Telegram threads, and it is not going to start now.
 * The shape of that blob belongs to `telegram/topics.ts`, which is the only thing that
 * reads it.
 *
 * One path, one lock, an atomic write. A partial pin and a partial topic map were never
 * a state we wanted to be reachable, and with two files it was.
 */
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

/** The pinned "current mode" message(s) in the owner's DM. */
export interface ModePin {
	ownerChatId: number;
	messageIds: number[];
}

export interface DmState<TTopics> {
	topics?: TTopics;
	modePin?: ModePin;
}

export interface DmStateStore<TTopics> {
	loadTopics(): Promise<TTopics | null>;
	saveTopics(topics: TTopics): Promise<void>;
	loadModePin(): Promise<ModePin | null>;
	saveModePin(pin: ModePin): Promise<void>;
	/** Forget the pin entirely (an error path: better a new one than a ghost). */
	clearModePin(): Promise<void>;
}

export function createDmState<TTopics>(
	fs: TelegramFs,
	path: string,
): DmStateStore<TTopics> {
	async function read(): Promise<DmState<TTopics>> {
		return (await readJsonIfExists<DmState<TTopics>>(fs, path)) ?? {};
	}

	/**
	 * Read, change, write back — under the lock, so a topic rename and a pin update that
	 * land together cannot each write a copy of the file that is missing the other's work.
	 */
	async function edit(
		change: (state: DmState<TTopics>) => void,
	): Promise<void> {
		await withFileWriteLock(path, async () => {
			const state = await read();
			change(state);
			await writeJson<DmState<TTopics>>(fs, path, state);
		});
	}

	return {
		async loadTopics() {
			return (await read()).topics ?? null;
		},
		async saveTopics(topics) {
			await edit((state) => {
				state.topics = topics;
			});
		},
		async loadModePin() {
			return (await read()).modePin ?? null;
		},
		async saveModePin(pin) {
			await edit((state) => {
				state.modePin = pin;
			});
		},
		async clearModePin() {
			await edit((state) => {
				state.modePin = undefined;
			});
		},
	};
}
