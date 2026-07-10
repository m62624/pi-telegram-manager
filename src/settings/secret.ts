/**
 * Resolve a possibly-indirect secret (the bot token) so it need not sit on
 * disk in plaintext.
 *
 * A settings value of the form `"env:NAME"` is read from `process.env.NAME` at
 * use time; any other non-empty string is treated as the literal secret. This
 * lets a user keep the token only in their environment
 * (`"botToken": "env:TELEGRAM_BOT_TOKEN"`) rather than in settings.json.
 */
const ENV_PREFIX = "env:";

/** Resolve a secret value, dereferencing an `env:NAME` indirection. */
export function resolveSecret(
	value: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (!value) return undefined;
	if (value.startsWith(ENV_PREFIX)) {
		const name = value.slice(ENV_PREFIX.length).trim();
		const resolved = name ? env[name] : undefined;
		return resolved && resolved.length > 0 ? resolved : undefined;
	}
	return value;
}

/** True when a value references the environment rather than embedding the secret. */
export function isEnvReference(value: string | undefined): boolean {
	return typeof value === "string" && value.startsWith(ENV_PREFIX);
}
