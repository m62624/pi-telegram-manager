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

/** e.g. `[Now: Mon 2026-07-10 14:32 +05:00]`. */
export function formatNowLine(now: number, timezone?: string): string {
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
	return `[Now: ${parts.weekday} ${date} ${time} ${offset}]`;
}

/**
 * The clock as a standalone context message (mode 1 / mixed-coding), where it is
 * the LAST message the model reads and is therefore easy to mistake for a fresh
 * prompt: traces showed the model stopping mid-task to reason about "the system is
 * telling me the current time". So it is labelled as background and says outright
 * that no reply is wanted. The manager's contexts embed the clock in a message that
 * already carries a directive, so they keep the bare {@link formatNowLine}.
 */
export function backgroundNowMessage(now: number, timezone?: string): string {
	return (
		"[Background, not a message from anyone: the clock, refreshed every turn. " +
		"Do not reply to it, do not comment on it — just carry on with the task " +
		`above. ${formatNowLine(now, timezone)}]`
	);
}
