/**
 * A real plugmem workspace in a throwaway directory.
 *
 * Every test gets its own root, and that is not tidiness — a `Workspace` releases a
 * database's file lock after its own bookkeeping, so a second `Workspace` opened on
 * the same root in the same process can be told the database "is in use by another
 * process". One root per test makes the question moot.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryWorkspace } from "../../src/storage/memory";
import { createPlugmemWorkspace } from "../../src/storage/memory-plugmem";
import { buildPlugmemConfig } from "../../src/storage/plugmem-config";

export interface TempMemory {
	workspace: MemoryWorkspace;
	root: string;
	/** Close the workspace and delete the directory. */
	dispose(): Promise<void>;
}

/** Open a real workspace with no embedder — the default configuration. */
export function tempMemory(): TempMemory {
	const root = mkdtempSync(join(tmpdir(), "ptm-memory-"));
	const configPath = join(root, "config.toml");
	writeFileSync(configPath, buildPlugmemConfig({ enabled: false, dim: 0 }));
	const workspace = createPlugmemWorkspace(root, {
		configPath,
		idleTimeoutMs: 60_000,
	});
	return {
		workspace,
		root,
		async dispose() {
			await workspace.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
