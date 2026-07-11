/** Narrow an unknown throwable to a Node.js errno error (has a `.code`). */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
