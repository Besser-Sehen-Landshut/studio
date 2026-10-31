# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [0.1.0] - 2026-10-31

First release: stage (a), the control-room core. Not tagged or published as a GitHub release yet;
the maintainers tag after the merge.

### Added

- Claude Code plugin and marketplace manifests (`studio`, `studio-marketplace`).
- Typed configuration: `.studio/studio.yaml`, `.studio/board.yaml`, an owner config for settings that
  open reads on the owner's machine, and generated JSON Schemas.
- Board with a validated status machine and per-item history.
- Planner: Definition of Ready, per-role WIP limits, dependency, `touches` and `conflicts_with`
  checks, priority order.
- Capacity from CI runners (GitHub-hosted, self-hosted or both) and host load.
- Crew launch in per-item blob-less clones with an isolated `HOME`, sandbox settings, a
  least-privilege crew token, and a PreToolUse guard hook (fails closed).
- Crew reports (written last, untracked) verified by `studio collect` against the PR head SHA.
- Merge queue: one PR at a time, every required check green on the exact head SHA, capacity checked
  twice, merge pinned to the head SHA. `queue run` holds a lock, picks up PRs added while it runs,
  moves each board item as soon as its PR is done and gives a new head 5 minutes to report checks.
- Runtime state outside the repository in a per-project state root (0700, symlink-safe, bound to the
  project by a marker).
- CLI: `board`, `plan`, `launch`, `status`, `collect`, `queue add|run`, `state`, `stop`, `metrics`.
- Skills `studio-lead` and `studio-crew`.
- Self-contained bundles in `dist-bundle/`, so an installed plugin runs without `node_modules`.
- CI: lint, typecheck, tests, bundle drift check, secret scan, private-string scan.

### Security

- Layered model: sandbox, least-privilege token, server-side branch protection, guard hook. The
  guard is a convenience layer, not a security boundary. See `SECURITY.md`.
- The guard allows only the crew's tools; web and MCP tools are denied, and crew sessions start
  without MCP servers. A guard hook that cannot run blocks the call.
- Crew clones push to `https://github.com/<repo>.git` with the crew token; `launch` deletes an
  earlier report, `collect` refuses while the crew runs or when the report predates the run.
