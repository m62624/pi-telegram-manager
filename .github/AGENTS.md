# AGENTS.md — .github (CI / release automation)

## Purpose
GitHub automation for this TypeScript Pi extension: CI, PR labeling, the release-candidate
+ npm publish flow, generated release notes, the Pi SDK watcher, and the Tangled mirror.

## Parent
- `../AGENTS.md`

## Stable Contracts
- CI runs `npm run check` (biome), `npm run build` (tsc), `npm test` (vitest), and `npm pack --dry-run`.
- Only the `CI passed` check is a required branch-protection gate — it aggregates the real jobs.
- npm publishing uses **trusted OIDC publishing** (`id-token: write`), NOT an npm token secret.
- Release notes depend on PR labels; the labeler and the changelog config must key off the same names.
- This is a TypeScript package: never add Rust/bench steps.

## Read First
- `workflows/ci.yml`
- `workflows/release.yml`
- `workflows/labeler.yml`
- `release.yml`

## Domain details
- `workflows/ci.yml` → runs on **push to any branch** (`branches: ['**']`, not tags) touching `src/**` or
  config files, on **every pull_request** (no base-branch filter — any target), via `workflow_call` with a
  `ref` input (used by `release.yml`'s `tests` job), and via `workflow_dispatch`. The `build` job runs
  check/build/test/pack; the `ci-pass` job is the single required gate.
- `workflows/release.yml` → triggered by pushing a **`pin/v*`** tag. Flow: `prepare` (parse version from
  the tag, create an `rc/vX.Y.Z` branch, bump `package.json`/`package-lock.json`, delete the pin tag) →
  `tests` (calls `ci.yml` against the RC branch) → `publish` (npm publish via trusted OIDC, `id-token:
  write`, skips if the version is already on npm) → `release` (re-tag `vX.Y.Z`, open/find a sync PR from the
  RC branch back to the default branch, generate release notes, create a **draft** GitHub release).
- `release.yml` (repo-root, not a workflow) → GitHub auto-generated-release-notes config; buckets PRs into
  changelog categories by label. Renaming a label in `workflows/labeler.yml` without updating this file
  silently drops PRs into "Other Changes".
- `workflows/labeler.yml` → on PR opened/edited/synchronized, parses the PR title for a Conventional-Commits
  prefix (`feat:`, `fix:`, …) and applies/creates the matching label (plus `breaking` for a `!`).
- `workflows/sdk-watch.yml` → daily watch of `@earendil-works/pi-coding-agent`. Reference point is the
  **pinned devDependency version** in `package.json` (not a source constant). When the latest is past the
  pin, it opens ONE self-rewriting draft PR on the `sdk-watch` branch that bumps the `pi-coding-agent` /
  `pi-tui` devDependency pins and runs build + tests against the new SDK, surfacing a pass/fail badge. Stands
  down if a human pushes to the branch; auto-closes when the pin matches latest again. Excluded from
  Dependabot to avoid duplicate PRs.
- `workflows/mirror-tangled.yml` → mirrors `main` (+ tags) to a Tangled remote on every push to `main`.
  Owner-gated (`m62624`). Needs secret `TANGLED_SSH_KEY` and variable `TANGLED_REMOTE`; errors clearly if
  unset. Optional — skip entirely if not mirroring.
- `dependabot.yml` → weekly grouped minor/patch npm bumps (majors held for manual review) and grouped
  GitHub-Actions bumps. The Pi SDK is excluded (owned by `sdk-watch`).

## Do not touch unless
- Do not switch npm publishing to a token-based flow — trusted OIDC publishing is intended.
- Do not make a real CI job (not `ci-pass`) the required check, or branch protection breaks when jobs change.
