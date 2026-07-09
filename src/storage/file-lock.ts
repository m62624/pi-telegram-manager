// Serializes read-modify-write on a single file so concurrent callers do not
// clobber each other's update. Pi executes every tool call in one assistant
// message concurrently, so a batch of writes to the same record would otherwise
// each read the same base, mutate their own copy, and let the last writer win —
// silently dropping the rest. Every record store routes its `update*` helper
// through this so "no lost update" is one invariant in one place.
//
// In-process only: it does not protect against a second OS process touching the
// same file. The extension runs in a single process, so that is sufficient.
//
// The lock is a release-based mutex keyed by the file path. Different paths do
// not block each other. A rejected operation still releases the lock (the
// `finally`), so one failure cannot wedge later writes.
const fileWriteLocks = new Map<string, Promise<void>>();

export async function withFileWriteLock<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = fileWriteLocks.get(path) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	fileWriteLocks.set(path, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (fileWriteLocks.get(path) === queued) {
			fileWriteLocks.delete(path);
		}
	}
}
