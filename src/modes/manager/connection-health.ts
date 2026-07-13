/**
 * What changed about a business connection, and whether the owner needs to hear
 * about it.
 *
 * A Secretary connection is configured in the Telegram app, not here: the owner
 * can revoke the bot's right to reply, or switch the whole connection off, at any
 * moment. Telegram then sends one `business_connection` update and nothing else —
 * from the inside, a bot stripped of `can_reply` looks exactly like a bot with
 * nothing to say. Everything the manager does afterwards fails silently.
 *
 * So we diff the stored connection against the incoming one and name the change.
 * Pure and structural: `index.ts` owns the sending, the store, and the API.
 */

/** The part of a connection whose change is worth a word to the owner. */
export interface ConnectionHealth {
	/** `undefined` on connections stored before rights existed — only an explicit false is a problem. */
	canReply?: boolean;
	isEnabled: boolean;
}

/**
 * - `disabled` — the connection was switched off; the manager is deaf and mute.
 * - `enabled` — it came back.
 * - `reply_right_lost` — still connected, but it may no longer answer anyone.
 * - `reply_right_restored` — it may answer again.
 */
export type ConnectionAlert =
	| "disabled"
	| "enabled"
	| "reply_right_lost"
	| "reply_right_restored";

/**
 * Name what changed between the stored connection and the incoming update.
 *
 * A first sighting (`previous === null`) raises nothing: startup diagnostics
 * already report the connection's state, and re-reporting it on the first update
 * would double every message. Only a real transition speaks.
 *
 * A connection that went off reports only that: a revoked reply right is
 * academic while the bot is receiving nothing at all, and two alarms for one
 * action read as noise.
 */
export function connectionAlerts(
	previous: ConnectionHealth | null,
	next: ConnectionHealth,
): ConnectionAlert[] {
	if (!previous) return [];
	if (previous.isEnabled && !next.isEnabled) return ["disabled"];

	const alerts: ConnectionAlert[] = [];
	if (!previous.isEnabled && next.isEnabled) alerts.push("enabled");
	// `undefined → false` is a real loss (an older stored record, then a revoke);
	// `false → undefined` is not a restoration, only the absence of news.
	if (previous.canReply !== false && next.canReply === false) {
		alerts.push("reply_right_lost");
	} else if (previous.canReply === false && next.canReply === true) {
		alerts.push("reply_right_restored");
	}
	return alerts;
}
