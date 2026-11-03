# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [0.6.4] - 2026-11-03

Not tagged yet; the maintainers tag after the merge.

### Changed

- Launches no longer wait for CI runners. A crew builds and tests in its own clone and puts no load
  on CI until a pull request exists, so busy runners kept crews idle for nothing. A fix, feature or
  chore still waits for the host load (`host_load_max`, or the cores with `shared_host`), now with
  the reason `host load` instead of `ci capacity`. A CI read error no longer holds launches either.
- A plan assigns at most one build item: the host load is a single, lagging reading. The other
  ready builds are deferred with `host load: one build start per plan` but still count against
  role WIP, credential slots and overlaps, so the items after them keep their usual reasons.
  `studio launch <id>` accepts a build deferred only for that reason, since each launch reads the
  host anew and starts one build.
- `collect` checks CI capacity before it opens a crew's pull request, with the merge queue's rule:
  at or below `merge_max_busy`, twice `check_twice_seconds` apart, a read error counting as busy.
  Without room it opens nothing, keeps the item's status and branch, notes
  `pr held: ci capacity (busy N of M, limit L)` and exits 1; a later `collect` opens the pull
  request once. An open pull request of the branch is still taken at once. Once the item holds a
  pull request, `pr held:` notes are removed. The board is read again right before
  `gh pr create`: an item that changed during the capacity wait gets no pull request, and
  `collect` exits 1.
- Capacity snapshots (`studio plan`, `state.json`) carry `hostOk`, the host part of `ok`.

### Added

- `studio setup ci` warns about a workflow whose `push` trigger matches crew branches
  (`studio/<id>`): every crew push would then start CI that no capacity check sees.

## [0.6.3] - 2026-11-03

Fixes from the second real crew run, a review. Not tagged yet; the maintainers tag after the merge.

### Added

- A review launch writes the pull request's title and text (as crew text, data only), its checks
  and its changed files to `briefs/<id>.caps/pull-request/`, read outside the sandbox; the brief
  names the files.
- `studio link <id> <repo>#<n>` (owner, terminal) ties a pull request opened by hand to its item,
  after checking repository, fork and branch.

### Changed

- `collect` takes an approval only while the pull request's checks pass; otherwise it refuses and
  nothing moves.
- A review launch refuses when no board item holds the pull request, naming `studio link`, since
  the approval would have nowhere to go. An unreadable board refuses a review launch too.

## [0.6.2] - 2026-11-03

Not tagged yet; the maintainers tag after the merge. 0.6.1 was not released: its default opened the
macOS trust service.

### Changed

- The macOS TLS trust service stays shut for crews unless the owner sets
  `crew_allow_macos_trust_service: true`, which weakens the network boundary (SECURITY.md). Without
  it, crews on macOS run no `gh`: they push, give `pr_title` in the report and the pull request text
  as its body, and `collect` opens the pull request with the crew token. CI checks, workflow runs
  and `gh api` are not available to such crews.
- `node --test` refuses a pattern segment that starts with a dot and holds a wildcard (`.*`, `.?`),
  since a shell may let it match `..`.

## [0.6.1] - 2026-11-03

Fixes from the first real crew run. Not tagged yet; the maintainers tag after the merge.

### Fixed

- `gh` in a crew on macOS failed TLS verification (`x509: OSStatus -26276`). Crew settings now let
  sandboxed commands reach exactly the macOS trust service `com.apple.trustd.agent`; see SECURITY.md.
- `cargo` could not start in a crew. With `~/.cargo/bin` and `~/.rustup` in `crew_toolchain_paths`,
  crews get `RUSTUP_HOME` and a `CARGO_HOME` in their own `HOME`. `~/.cargo/credentials*` are denied
  like other credential stores, so `~/.cargo` as a whole cannot be listed.
- `node --test` takes several paths and plain patterns such as `tooling/guards/*.test.mjs`. A
  brace pattern with `..` inside, which slipped through before, is refused.

### Added

- `studio doctor` checks that the project folder is a git checkout with `origin`, and names tools on
  `PATH` below the home that `crew_toolchain_paths` does not cover.

## [0.6.0] - 2026-11-03

Claude accounts kept by Studio. Not tagged yet; the maintainers tag after the merge.

### Added

- `studio account add <label>`: stores a token from `claude setup-token` (hidden input, owner only,
  terminal) in `tokens/<label>.json` in the owner config, mode 0600. The first account becomes
  active and installs the `superpowers` and `studio` plugins into the crew config dir.
- `studio account list`, `use <label>`, `remove <label>` and `setup-plugins`.
- Without a credential provider, crews use the active stored account with `CLAUDE_CODE_OAUTH_TOKEN`
  and the crew config dir `claude/` in the owner config, never `~/.claude`. Without accounts nothing
  changes.
- `studio doctor` shows how crews log in, the accounts and their state. It and `account list` warn
  30 days before a token is a year old; after that a launch refuses.
- README: "Claude accounts", and the layout of stored accounts as a contract for providers.

### Changed

- A credential provider's token now comes with the crew config dir `claude/` in the owner config
  instead of `~/.claude` or the launching shell's `CLAUDE_CONFIG_DIR`. Run
  `studio account setup-plugins` once before the next launch; until then a launch refuses.
- Errors about account files name only the file and an error code, never its content.
- Crew shell commands may read only `skills/`, `plugins/cache/` and `plugins/marketplaces/` of the crew's
  Claude config dir, no longer all of it. `account setup-plugins` needs the owner in a terminal.
  `account remove` runs under the launch lock and warns when the last account goes.

## [0.5.1] - 2026-11-03

No state should need a hand edit of the board before the first real crew run. Not tagged yet; the
maintainers tag after the merge.

### Added

- `studio drop <id>` ends an item. It refuses while its crew runs and names `studio stop`.
- `studio stop <id> --release` closes the record of a crew that cannot be verified, with no signal,
  and prints the pid and what to check by hand. Use it for a process group whose leader ended.

### Changed

- `collect`, a relaunch and `drop` go on when another process holds the crew's pid: that crew is gone.
  An unverified crew blocks them until it is released. No signal goes to a process without proof.
- The refusal for an open review names `studio drop`.
- `escalate` and applying queue results read the board and write it under `board.lock`.

## [0.5.0] - 2026-11-01

Stage (c): capabilities, tiered review, sources contract, role memory, model per type, more metrics.
Not tagged or published as a GitHub release yet; the maintainers tag after the merge.

### Added

- `capabilities/INDEX.yaml` with a loader and schema: per role, item type, stack, phase, path, risk
  and trigger, the skills, analyzers and knowledge a crew gets. The denied list wins. The brief names
  the skills; only matching files are copied beside it.
- `studio setup stack [--write]`: stacks from manifest files, stored in `studio.yaml`.
- A review routine in reviewer briefs, tiered by change size, with security always on for sensitive
  paths, a spec check with mutation probe, a fix limit and a similar-bug scan. `collect` holds the
  report to the record written at launch.
- `capabilities/SOURCES.yaml`, `studio setup sources` (records hashes), `studio sources check`
  (`fits` only when every file the contract reads is byte-identical; a changed file is `unclear`, a
  changed licence `conflict`; adopts nothing) and `studio sources apply <id>` (`fits` only).
- Role memory: `lessons` commands; `collect` only proposes.
- `roles.<role>.types`, `escalate_to` and `studio escalate <id>`; `skills.when`; board fields `risk`,
  `triggers`, `model`.
- `studio deploy record`, `studio incident open|resolve`; `metrics` shows change failure rate and
  time to restore. `studio flaky`, `studio solutions search`; `plan` lists matching solutions.

### Changed

- A review item needs the note `review <owner/repo>#<n>`; a launch without it refuses. `collect`
  refuses a finished review without the record of its launch: relaunch reviews started before this.
- Index rows add required skills: a `feature` or `fix` builder needs test-driven development, a `fix`
  also systematic debugging. A launch refuses when one is definitely not installed; deny it in
  `skills.denied` to opt out.
- Crew reports go to a file name drawn at each launch and named in the brief; `collect` reads only
  that file. A review report needs `head_sha`, checked against the pull request's head. Relaunch a
  crew started before this.
- `queue run` merges only an item that is `queued` on the board right before the merge.
- `model` values must look like a model name: they can no longer start with a dash.
- The brief says `Offered skills` in place of `Allowed skills`. `lessons` in a report are now stored.
- A review launch refuses a pull request from a fork, or one it cannot read. An approval counts only
  for the head the review was launched on.
- `queue add` needs an approval for the current head, and `queue run` checks again before the merge.
  `collect` stores the approved head and base on the item that holds the pull request
  (`approved_head`, `approved_base`). Another base refuses. Besides the approved head, one commit counts: it only merges
  the base into that head, GitHub signed it, and its tree equals a local `git merge-tree`. A conflict
  resolved by hand or a second update needs a new review. Pull requests approved or queued before
  this need a new review.
- Only one review of a pull request runs at a time, and `collect` applies only the verdict of the
  review started last (`supersededBy` names it otherwise).
- The pause and block check before a merge now runs after the approval check, as its last step.
- A review launch clears an earlier approval of that pull request, and refuses a base that is neither
  the default branch nor listed in the new `review_bases` setting (empty by default). The reviewer's
  brief fetches and diffs against that base. An open review of a pull request blocks `queue add` and
  the merge. Launch and collect change the board under a lock (`board.lock`).
- `studio stop` signals only a process with the start time stored at launch; another process on the
  pid gets no signal, and one that cannot be verified makes the stop fail.
- A failed fetch or a git older than 2.38 now says so when a merged base is checked. `studio doctor`
  shows the git version.
- A launch refuses when the Studio plugin is not installed in the crew's config dir, before anything
  is counted; a readable config dir with no skills or plugins now counts as not installed. `studio
  doctor` shows it with the install command and looks in a credential provider's config dir.

### Fixed

- A stray file such as `.DS_Store` in the plugin cache no longer hides a missing skill.

### Security

- A crew's `Read`, `Glob` and `Grep` reach only its clone, its own brief with `briefs/<id>.caps/` and
  `briefs/<id>.rules/`, its `HOME` and tmp dir, and in its config dir the skills, plugin cache,
  marketplaces and saved tool outputs. They refuse any `..` segment: write the path without it. A Glob pattern may hold only letters,
  digits and `_ - . / * ? , { }`, with flat braces. A
  `command` on any tool but Bash is denied. See `SECURITY.md`.
- Crew sessions set `CLAUDE_CODE_TMPDIR` to the crew's tmp dir.

## [0.4.0] - 2026-11-01

Stage (b): the Studio board inside Claude Code, pause and resume, push notifications. Not tagged or
published as a GitHub release yet; the maintainers tag after the merge.

### Added

- The Studio board inside Claude Code: a pane, a status line and toasts for the owner's interactive
  session in a Studio project, refreshed every 10 seconds, plus `/studio [status | pause | resume]`.
  It only displays: pausing and resuming still happen in a terminal, and `/studio` names the command
  to run. Crew sessions, `claude -p` and other projects get none of it.
- `studio pause` and `studio resume` (owner only, in a terminal): while paused nothing new is
  planned, launched or merged; running crews continue. A `pause.json` that cannot be read still
  pauses.
- `state.json` carries what a status pane needs: a state per crew (`working`, `waiting`, `blocked`,
  `stopped`, `crashed`, `done`) with title and repository, CI use, today's merges and deploys, runs
  per day and label, the state of the latest push builds on `main`, and the ready and queued counts.
  Labels only: no credential value is written.

- Push notifications: `notify: { channel, command }` in the owner config hands each line for the owner
  and each account block once to an owner-chosen command (absolute path, no shell, minimal
  environment, control characters stripped); `notified.json` in the owner root remembers what was sent.

### Fixed

- The crew guard denies running `studio` directly, and setting or unsetting `STUDIO_*`,
  `NODE_OPTIONS`, `NODE_PATH`, `npm_config_*`, `PNPM_*`, `YARN_*` and `COREPACK_*` (any case). It also
  denies `script`, `flock` and `watch`, arithmetic (`((`, `$((`, `$[`) and `${VAR:=x}` / `${VAR=x}`.
- `node` runs only as `node --version`, `node --help` or `node <literal relative path>` (no option
  before the path, no `..`, not the studio binary).
- `npm`, `pnpm`, `yarn` and `bun` pass only with a first argument from a short allowlist (`test`,
  `run`, `install`, `i`, `ci`, `lint`, `build`, `typecheck`, `format`, `add`, `remove`, `list`, `ls`,
  `audit`, `outdated`, `why`, `--version`, `-v`, `--help`); `--shell*` is denied anywhere. `npx`,
  `pnpx`, `bunx` and `corepack` are denied.
- The guard does not contain a malicious crew: `package.json` scripts can run anything. The boundary
  is the sandbox, the token and branch protection; owner-only commands need a terminal.
- Notifications stop at the first failing send in a run (one error, the rest is retried next run), and
  a `notify.lock` keeps overlapping `studio state` runs from sending twice or losing keys.
- `studio state` still writes `state.json` when crew records of another project cannot be read; it
  leaves out the per-label figures and adds a `crew-records` line for the owner. Plan and launch
  still refuse.
- `queue run` holds while old per-project state files have not been migrated.

### Fixed (crew guard usability)

The guard is a convenience layer, not the security boundary (`SECURITY.md`), so these loosen it for
real crews, for example in monorepos. This replaces the stricter wording under Fixed above for
package managers, `node` and variable names.

- `npm`, `pnpm`, `yarn` and `bun` pass with any command and any option (`pnpm -r test`,
  `pnpm --filter app test`, `pnpm -C app test`, `npm --prefix app test`, `pnpm test:unit`,
  `pnpm exec vitest run`, bare `yarn`). Denied: `npx`, `pnpx`, `bunx`, `bun x`, `corepack`, the
  commands `dlx`, `create`, `init`, `npm x` and `npm exec` (`pnpm exec` and `yarn exec` run local
  binaries and pass), and the options `--shell*` and `--script-shell`.
- `node --test` and `node --test <literal relative path>` pass.
- Only `npm_config_*` is matched case-insensitively: `path=src` and `env=prod` pass; `PATH=`, `HOME=`
  and the other uppercase names stay denied.
- `((` and `$((` inside quoted text no longer deny (`gh pr create --title "a ((b))"`); arithmetic in
  unquoted text and `$((` in double quotes still do. A nested subshell written `( (` is now denied too.
- Denial messages name the allowed alternative where there is one.
- Minimal skill edit: `studio-lead` retries a launch refused because of a lock on the next heartbeat
  tick instead of treating it as a failure (one sentence; baseline in `test/skills/baseline-lead.md`).

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
