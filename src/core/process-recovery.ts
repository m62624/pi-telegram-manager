/**
 * Stop a foreign process in a controlled way for the operator's explicit recovery
 * command. The process boundary is injected so this remains deterministic in tests.
 */

export interface ProcessRecoveryDeps {
	isAlive(pid: number): boolean;
	signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export interface ProcessRecoveryOptions {
	graceMs?: number;
	pollMs?: number;
}

export interface ProcessRecoveryResult {
	stopped: boolean;
	escalated: boolean;
	error?: unknown;
}

async function waitForExit(
	pid: number,
	deps: ProcessRecoveryDeps,
	graceMs: number,
	pollMs: number,
): Promise<boolean> {
	const deadline = deps.now() + graceMs;
	while (deps.isAlive(pid) && deps.now() < deadline) {
		await deps.sleep(pollMs);
	}
	return !deps.isAlive(pid);
}

/** Send SIGTERM, then SIGKILL only if the process ignores the graceful stop. */
export async function stopProcess(
	pid: number,
	deps: ProcessRecoveryDeps,
	options: ProcessRecoveryOptions = {},
): Promise<ProcessRecoveryResult> {
	const graceMs = options.graceMs ?? 3_000;
	const pollMs = options.pollMs ?? 100;
	if (!deps.isAlive(pid)) return { stopped: true, escalated: false };

	let error: unknown;
	try {
		deps.signal(pid, "SIGTERM");
	} catch (cause) {
		error = cause;
		if (!deps.isAlive(pid)) return { stopped: true, escalated: false };
	}
	if (await waitForExit(pid, deps, graceMs, pollMs)) {
		return { stopped: true, escalated: false, error };
	}

	try {
		deps.signal(pid, "SIGKILL");
	} catch (cause) {
		return {
			stopped: !deps.isAlive(pid),
			escalated: true,
			error: cause,
		};
	}
	return {
		stopped: await waitForExit(pid, deps, graceMs, pollMs),
		escalated: true,
		error,
	};
}
