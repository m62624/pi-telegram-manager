/**
 * Format the current date/time for the model.
 *
 * We replace the whole LLM context in mode 2 (and prepend a system block in mode
 * 1), so Pi's own "today is …" line never reaches the model — we add our own.
 * The line is `[Now: Mon 2026-07-10 14:32 +05:00]`: weekday, ISO date, 24-hour
 * time, and the UTC offset, rendered in the configured IANA `timezone` (or the
 * host's system zone when unset). An invalid zone falls back to system time
 * rather than throwing.
 *
 * Pure over an injected epoch-millis `now`, so it is unit-testable with a fixed
 * clock and a fixed zone.
 */
function partsFor(
	now: number,
	timezone: string | undefined,
): Record<string, string> {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	});
	const parts: Record<string, string> = {};
	for (const part of format.formatToParts(new Date(now))) {
		parts[part.type] = part.value;
	}
	return parts;
}

/** e.g. `Mon 2026-07-10 14:32 +05:00` — the clock, without any framing. */
export function formatClock(now: number, timezone?: string): string {
	let parts: Record<string, string>;
	try {
		parts = partsFor(now, timezone);
	} catch {
		// Invalid IANA zone → fall back to the host's system zone.
		parts = partsFor(now, undefined);
	}
	// `longOffset` renders "GMT+05:00" (or just "GMT" at UTC); normalise to
	// "+05:00" / "+00:00".
	const offsetRaw = (parts.timeZoneName ?? "").replace("GMT", "");
	const offset = offsetRaw === "" ? "+00:00" : offsetRaw;
	const date = `${parts.year}-${parts.month}-${parts.day}`;
	const time = `${parts.hour}:${parts.minute}`;
	return `${parts.weekday} ${date} ${time} ${offset}`;
}

/** e.g. `[Now: Mon 2026-07-10 14:32 +05:00]`. */
export function formatNowLine(now: number, timezone?: string): string {
	return `[Now: ${formatClock(now, timezone)}]`;
}

/**
 * There used to be a third function here: the clock as a standalone context
 * message for mode 1, appended before every call to the model. It is gone. A
 * message is a turn, and the model answered it — every few seconds, out loud, into
 * the chat. The clock now rides in the header of the message it belongs to
 * (`TurnInput.receivedAt`) in mode 1, and in the manager's own turn directive in
 * mode 2 — both of which are things the model is meant to read. See
 * `core/connect-context.ts`.
 */
