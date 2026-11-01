# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [Unreleased]

### Added

- `studio pause` and `studio resume` (owner only, in a terminal): while paused nothing new is
  planned, launched or merged; running crews continue. A `pause.json` that cannot be read still
  pauses.
- `state.json` carries what a status pane needs: a state per crew (`working`, `waiting`, `blocked`,
  `stopped`, `crashed`, `done`) with title and repository, CI use, today's merges and deploys, runs
  per day and label, the state of the latest push builds on `main`, and the ready and queued counts.
  Labels only: no credential value is written.

### Fixed

- The crew guard denies `studio` whatever the arguments, also through `node`, and denies `node` with
  a script argument that is not literal, and setting or unsetting `STUDIO_*` variables. Before, `$(...)`,
  `$VAR` or a glob got past the check of owner-only subcommands. `node app.js pause` and
  `npm run resume` are no longer denied.
- The crew guard also denies `script`, `flock`, `watch`, `npx`/`pnpm exec`/`pnpm dlx`/`yarn`/`npm exec`
  when the target is `studio` or not literal, and setting `NODE_OPTIONS`. `npx vitest`, `pnpm test`
  and `npm run resume` stay allowed.
- Notifications stop at the first failing send in a run (one error, the rest is retried next run), and
  a `notify.lock` keeps overlapping `studio state` runs from sending twice or losing keys.
- `studio state` still writes `state.json` when crew records of another project cannot be read; it
  leaves out the per-label figures and adds a `crew-records` line for the owner. Plan and launch
  still refuse.
- `queue run` holds while old per-project state files have not been migrated.

### Changed

- Account blocks, usage limits and per-label usage are owner-wide, in `<state base>/owner`: a block
  recorded by one project stops the crews of all projects and refuses their launches, and
  `max_parallel` and `max_runs_per_day` count across projects. Old per-project files are merged on
  first use; a file that cannot be read is kept as `<name>.legacy-<project root>` and holds all work
  until the owner removes it.

## [0.3.0] - 2026-11-01

Stage (a.2): account blocks, usage limits per credential and pinned crew rules. Not tagged or
published as a GitHub release yet; the maintainers tag after the merge.

### Added

- Account blocks: when a crew log shows Claude Code reporting a failed authentication or a blocked
  account or organization, Studio records it in `blocks.json`, stops every crew of the project and
  starts nothing, with no provider call, until the owner runs `studio accounts-clear <label>` in a
  terminal. An unreadable `blocks.json` counts as blocked. `state.json` gets one `account-block`
  `forOwner` line and a `notifications` array. `studio accounts-clear <label>` (owner, in a terminal)
  clears a label's block.
- Usage limits per credential: `crew_label_limits` in the owner config sets `max_parallel` and
  optionally `max_runs_per_day` per credential label, with a `timezone` for the day. Counts live in
  `usage.json` in the state root and show in `state.json` as `labelUsage`. A label at its limit is
  excluded like a parked one, and launches of one project are serialised with a `launch.lock`.
- Guard: `git update-ref`, `git replace`, `git symbolic-ref` and fetch refspecs that write below
  `refs/remotes/` are denied.

### Changed

- Before a block signals a crew, the process start time stored at launch is compared; a mismatch
  means the crew is gone, and a crew whose identity cannot be verified is reported, not signalled.
  A launch whose new process has no readable identity is stopped and refused.
- Crew rules come from a pinned copy outside the clone (issue #6). Studio fetches `origin/main` in
  the owner's checkout, reads `AGENTS.md` and `CLAUDE.md` at that SHA (plain files only, at most
  256 KiB, replace objects ignored) and saves them next to the brief; the brief points to the copies
  instead of telling the crew to run `git show` in its own clone. Items in a secondary repository
  get the rules of the project checkout. A failed fetch refuses the launch.
- Crew runs have Claude Code auto memory off: `autoMemoryEnabled: false` and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the crew settings file.

## [0.2.0] - 2026-11-01

Stage (a.1): your own runners. Not tagged or published as a GitHub release yet; the maintainers
tag after the merge.

### Added

- `studio setup ci [--write] [--json]`: detects CI runners, proposes the `ci:` block, lints
  workflows (`runs-on` labels against online runners, one concurrency group per workflow of the form
  `<prefix>-${{ github.head_ref || github.ref_name }}`) and refuses self-hosted runners on public
  repositories. `--write` updates only the `ci:` block. Runners that only GitHub-hosted workflows
  ignore give `github-hosted`, with a note.
- `ci.shared_host` and `ci.github_hosted_limit` in `.studio/studio.yaml` (and the JSON Schema).
- Host port `cpuCount()`.
- Credential provider: `crew_credential_command` in the owner config hands a crew run a label and
  either `CLAUDE_CODE_OAUTH_TOKEN` (the verified fallback) or `CLAUDE_CONFIG_DIR` (accepted; it has
  not yet been verified with an isolated `HOME` on macOS). Only the label is stored.
- `studio secret set crew-token`: hidden input, checked against GitHub, installed with mode 0600
  only after the check passes. Launch uses `crew_token.env` first, then this file.
- `studio doctor`: lists what is set and what is missing, never values.
- Usage limits: a limit event in a crew log stops the run, parks its label in `limits.json` in the
  state root and returns the item to `ready`, keeping clone and branch; the next launch resumes the
  session when the clone is still there and the credential allows it. All wordings of the form
  `You've hit your <words> limit` count; `kind` is `weekly` when the label contains the word weekly (any case). A recovered `rate_limit` retry is ignored, and a retry alone never stops a
  running crew. With no credential available nothing starts and `forOwner` gets one line.
- Ports `credentials.runProvider` and `credentials.ghWithToken`.

### Changed

- Capacity with `runners: both` counts only self-hosted busy runners in `ci_busy`; GitHub-hosted
  runs are reported as `githubHostedBusy` and compared with `github_hosted_limit`. Without that
  limit a warning says GitHub-hosted concurrency is not checked.
- With `shared_host: true`, capacity also requires the host load to stay at or below
  `host_load_max` (default: the number of CPU cores).
- Dependabot opens a separate pull request for major updates.
- **API billing is off by default.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` no longer reach
  crew sessions, and a launch refuses the owner's Claude settings that set `apiKeyHelper` or those variables.
  Set `allow_api_billing: true` in the owner config to allow them.
- Crews ignore repo-controlled Claude Code settings: every launch, fresh or resumed, passes
  `--setting-sources user`, so the clone's `.claude/settings.json` and `.claude/settings.local.json`
  (hooks, `env`, `apiKeyHelper`) no longer apply, and Studio no longer reads them. Only user settings
  and the file passed with `--settings` apply. Crews therefore do not auto-load the project
  `CLAUDE.md`, rules, skills, commands or subagents; the crew brief tells them to read `AGENTS.md`
  and `CLAUDE.md` from `origin/main` (`git show`, not the working tree), refusing entries whose
  mode is not 100644, and never to let them direct credentials, remotes, new hosts or the report
  contract. A required skill that is not available means a `blocked` report naming the skill, and
  a launch refuses when a role's required skill is definitely absent from the crew's config dir
  (`skills/` or the plugin cache); an unreadable directory does not refuse.
- Self-hosted capacity fails closed with a stated error when a read finds no matching organisation
  runner. Repository-level runners are not supported by capacity.
- The owner config directory is denied to crew sessions, and crew toolchain paths may not open it.
- The board allows `assigned` and `in_progress` to return to `ready`.

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
