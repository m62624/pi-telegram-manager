/**
 * The one place a path written by a HUMAN becomes a path we hand to the
 * filesystem. Every owner-configurable location goes through here — where inbound
 * files are saved (`files.downloadDir`), where tool outputs are written
 * (`assistant.toolOutputDir`), instruction files — so they cannot drift apart and
 * accept different things.
 *
 * The same `settings.json` travels between machines, so both flavours are accepted:
 * POSIX (`/var/log/pi`, `~/logs`, `./out`) and Windows (`C:\logs`, `D:/logs`,
 * `~\logs`, and UNC `\\server\share`). A leading `~` expands to the home directory
 * with whichever separator that home directory itself uses.
 *
 * Nothing else is rewritten. A path is used exactly as written, so a Windows path
 * on Linux fails as a missing directory — an honest error you can read — instead of
 * being silently "corrected" into some other directory, which is how files end up
 * somewhere nobody looks.
 */

/** Expand a leading `~`, `~/…` or `~\…` against `homeDir`; anything else is returned as-is. */
export function expandHomePath(path: string, homeDir: string): string {
	if (path === "~") return homeDir;
	if (!path.startsWith("~/") && !path.startsWith("~\\")) return path;
	const rest = path.slice(2);
	// Match the home directory's own flavour: a Windows home takes backslashes.
	const windowsHome = homeDir.includes("\\") && !homeDir.includes("/");
	const separator = windowsHome ? "\\" : "/";
	return `${homeDir.replace(/[/\\]$/, "")}${separator}${rest}`;
}

/**
 * Resolve an owner-configured directory, falling back to `fallbackDir` when it is
 * unset or blank (a `"  "` in a config file means "I did not set this", not "save
 * my files to a directory named space").
 */
export function resolveUserDir(
	configured: string | undefined,
	fallbackDir: string,
	homeDir: string,
): string {
	const raw = configured?.trim();
	if (!raw) return fallbackDir;
	return expandHomePath(raw, homeDir);
}
