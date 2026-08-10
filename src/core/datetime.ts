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

/** A calendar day as the model writes one, and the only shape accepted from it. */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Midnight of an ISO day, in the same zone the `[Now: …]` line is rendered in.
 *
 * The model is shown a date and asks about dates; the memory is addressed in
 * milliseconds. Converting between them is this function's whole job, and the zone
 * matters because the two ends must agree: a bot told it is Tuesday in Almaty and then
 * given a window computed in UTC would answer about a day that is five hours out.
 *
 * The offset is read at the instant being converted rather than assumed, so a zone
 * that changes offset during the year is handled. The half-hour of a DST transition is
 * not: a day is the unit here, and no question asked of this memory turns on it.
 *
 * Returns `null` for anything that is not `YYYY-MM-DD` — the caller reports that as a
 * tool error, because a silently-guessed date is a wrong answer with no symptom.
 */
export function startOfDay(day: string, timezone?: string): number | null {
	const match = ISO_DAY.exec(day.trim());
	if (!match) return null;
	const [, year, month, date] = match;
	const utc = Date.UTC(Number(year), Number(month) - 1, Number(date));
	if (!Number.isFinite(utc)) return null;
	let parts: Record<string, string>;
	try {
		parts = partsFor(utc, timezone);
	} catch {
		parts = partsFor(utc, undefined);
	}
	// What the zone calls that instant, back as UTC: the difference is its offset.
	const shown = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
	);
	return utc - (shown - utc);
}

/** One millisecond before the next day begins — the end of `day`, inclusive. */
export function endOfDay(day: string, timezone?: string): number | null {
	const start = startOfDay(day, timezone);
	return start === null ? null : start + 86_400_000 - 1;
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
