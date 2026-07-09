/**
 * Turn an arbitrary identifier (e.g. a Telegram chat id) into a filesystem-safe
 * path segment. Keeps alphanumerics, `-` and `_`; everything else (including
 * `/` and `.`) becomes `_`, which prevents path traversal and hidden files.
 */
export function sanitizeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned.length > 0 ? cleaned : "_";
}
