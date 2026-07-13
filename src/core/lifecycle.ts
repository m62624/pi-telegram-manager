import { randomUUID } from "node:crypto";
import type { BridgeMode } from "../constants";
import {
	isSingletonStale,
	type SingletonStore,
	type TelegramSingletonRecord,
} from "../storage/singleton-store";

/**
 * Owns "which mode is active", enforcing the plan's invariants:
 * - both modes default OFF; nothing auto-activates,
 * - the two modes are mutually exclusive,
 * - a crashed owner (dead pid / lapsed heartbeat) is reset to inactive.
 *
 * All time/identity/pid inputs are injected so the state machine is unit-testable.
 */
export interface LifecycleDeps {
	store: SingletonStore;
	now(): number;
	ownPid: number;
	instanceId?: string;
	isPidAlive(pid: number): boolean;
	heartbeatTimeoutMs: number;
}

export interface ActivateInput {
	mode: BridgeMode;
	chatId?: string;
	sessionFile?: string;
	workdir?: string;
}

export type ActivateResult =
	| { ok: true; record: TelegramSingletonRecord }
	| { ok: false; reason: string; current: TelegramSingletonRecord };

export interface LifecycleController {
	/** Resolve the active record, clearing (and returning null for) a stale one. */
	resolveActive(): Promise<TelegramSingletonRecord | null>;
	/** Turn a mode on. Rejects if a different (live) mode already owns the bridge. */
	activate(input: ActivateInput): Promise<ActivateResult>;
	/** Turn a mode off (only if this instance owns that mode). */
	deactivate(mode: BridgeMode): Promise<void>;
	/** Refresh the heartbeat if this instance owns the active record. */
	heartbeat(): Promise<void>;
}

export function createLifecycleController(
	deps: LifecycleDeps,
): LifecycleController {
	const instanceId = deps.instanceId ?? randomUUID();

	function staleOpts() {
		return {
			now: deps.now(),
			ownPid: deps.ownPid,
			heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
			isPidAlive: deps.isPidAlive,
		};
	}

	async function resolveActive(): Promise<TelegramSingletonRecord | null> {
		const record = await deps.store.load();
		if (!record) return null;
		if (isSingletonStale(record, staleOpts())) {
			// Owner crashed/exited: reset to "nothing active" (default OFF).
			await deps.store.clear();
			return null;
		}
		return record;
	}

	return {
		resolveActive,

		async activate(input) {
			const current = await resolveActive();
			if (current) {
				// A live bridge already exists. Mutual exclusion: reject anything that
				// is not this exact instance re-affirming the same mode.
				if (current.pid !== deps.ownPid || current.mode !== input.mode) {
					return {
						ok: false,
						reason:
							current.mode === input.mode
								? "already active in another instance"
								: `the other mode (${current.mode}) is active; disable it first`,
						current,
					};
				}
			}
			const now = deps.now();
			const record: TelegramSingletonRecord = {
				mode: input.mode,
				pid: deps.ownPid,
				instanceId,
				startedAt: now,
				heartbeatAt: now,
				chatId: input.chatId,
				sessionFile: input.sessionFile,
				workdir: input.workdir,
			};
			await deps.store.save(record);
			return { ok: true, record };
		},

		async deactivate(mode) {
			await deps.store.update((current) => {
				if (!current) return null;
				if (current.pid === deps.ownPid && current.mode === mode) {
					return null; // clear
				}
				return current; // not ours — leave untouched
			});
		},

		async heartbeat() {
			await deps.store.update((current) => {
				if (!current || current.pid !== deps.ownPid) return current;
				return { ...current, heartbeatAt: deps.now() };
			});
		},
	};
}

/**
 * Real pid-liveness probe. `process.kill(pid, 0)` sends no signal; it throws
 * ESRCH when the process is gone and EPERM when it exists but is not ours
 * (still alive).
 */
export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
