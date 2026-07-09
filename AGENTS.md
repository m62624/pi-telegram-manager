# AGENTS.md — pi-telegram-manager

## Purpose
Pi extension bridging a Telegram bot to a local Pi agent, in two mutually-exclusive modes:
terminal-continuation (`connect`) and business manager (`manager`).

## Architecture (flat domain DAG; `src/index.ts` is the only composition root)
- `pi/` — the ONLY boundary that imports `@earendil-works/*` (SDK). Enforced by an invariant test.
- `telegram/` — grammY client + raw-api escape for Bot API 10.1 methods, updates, media, rich rendering.
- `storage/` — ACID JSON/JSONL (atomic temp+rename, in-process file lock). Source of truth.
- `settings/` — defaults → global → project merge with bespoke normalizers.
- `core/` — shared kernel: lifecycle (mode activation), instructions, timers, queue, turns, abort, render.
- `ui/` — Pi TUI indicators (footer, manager banner).
- `modes/connect` and `modes/manager` — the two mode controllers.

## Stable Contracts
- One Pi extension entrypoint: `export default (pi: ExtensionAPI) => void`.
- Modes are mutually exclusive; default OFF; explicit enable/disable; crash-reset via stale pid/heartbeat.
- Manager context isolation uses `pi.on("context")` to rebuild `messages` from the active chat only.
- Reply decision uses tools `manager_reply` / `manager_silent` (not text sentinels).

## Conventions
- Raw TypeScript shipped (Pi runs it); `tsc` is typecheck-only. ESM, tabs, double quotes (biome).
- **All tests and mocks live in `tests/`** (never in `src/`). Test via the latest vitest.
- Every runtime is a `create*Runtime(deps)` factory / class with injected ports (fake-ports testing).

## Read First
The approved plan: `~/.claude/plans/lazy-giggling-gosling.md`.
