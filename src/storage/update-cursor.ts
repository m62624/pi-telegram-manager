/**
 * The high-water mark of Telegram `update_id`s this bot has already taken in.
 *
 * The manager/mixed client polls with `drop_pending_updates: false` on purpose,
 * so a message sent while the bot was offline is redelivered on the next start
 * and nothing is missed. That backlog has a sharp edge: grammY confirms an
 * update's offset to Telegram only on the NEXT poll, AFTER the handler for it
 * returns. A handler that kills the process before then — `shutdown -h now`, a
 * reboot, an OOM — never lets that confirmation happen, so Telegram redelivers
 * the very update that took the process down, and it runs again on boot. The
 * shutdown command re-fires; the machine cannot stay up.
 *
 * This cursor closes that loop. Every inbound update is CLAIMED here — its id
 * recorded durably — BEFORE it is dispatched. A redelivery after a restart is an
 * id at or below the mark, and is skipped: acknowledged to Telegram (grammY
 * still advances the offset), never handed to a handler a second time.
 *
 * The trade is deliberate: an update whose handler hard-kills the process is
 * processed AT MOST once, not endlessly. A "poison" message that reliably
 * crashes the bot is dropped rather than looped — which for a shutdown is
 * exactly right, and for an ordinary message is a single lost redelivery whose
 * content the manager's transcript-based catch-up can still recover.
 *
 * The id is monotonic per bot, so the whole state is one number.
 */
import { withFileWriteLock } from "./file-lock";
import type { TelegramFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

export interface UpdateCursor {
	/**
	 * Claim `updateId` for processing. Records it as seen (durably, under the
	 * lock) and returns true when it is new; returns false without changing
	 * anything when it is at or below the mark — a redelivery to skip.
	 */
	claim(updateId: number): Promise<boolean>;
}

type CursorFile = { lastUpdateId: number };

export function createUpdateCursor(fs: TelegramFs, path: string): UpdateCursor {
	return {
		async claim(updateId) {
			if (!Number.isFinite(updateId)) return true;
			return await withFileWriteLock(path, async () => {
				const last = (await readJsonIfExists<CursorFile>(fs, path))
					?.lastUpdateId;
				// Already seen (or an out-of-order redelivery): skip without a write.
				if (last !== undefined && updateId <= last) return false;
				await writeJson<CursorFile>(fs, path, { lastUpdateId: updateId });
				return true;
			});
		},
	};
}
