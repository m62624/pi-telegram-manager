/**
 * Coerce any thrown value into a human-readable message. Small local models can
 * throw non-Error values; callers use this so a bad throw never surfaces as
 * "[object Object]".
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Narrow an unknown throwable to a Node.js errno error (has a `.code`). */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
