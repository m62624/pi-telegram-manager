/**
 * Wait for an asynchronous cleanup operation for at most `timeoutMs`.
 *
 * Cleanup must not keep the rest of a runtime teardown hostage to a remote
 * request. The operation is still allowed to finish in the background, but
 * the caller can continue clearing local state and releasing its ownership.
 */
export async function withTimeout(
	operation: () => Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> {
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = Promise.resolve()
		.then(operation)
		.catch(() => undefined);
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve();
		}, timeoutMs);
	});

	await Promise.race([cleanup, timeout]);
	if (timer !== undefined) clearTimeout(timer);
	return !timedOut;
}
