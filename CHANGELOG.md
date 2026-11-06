# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [0.23.1] - 2026-11-06

### Fixed

- Migration numbers: an open pull request's new migrations are read from tree listings of the migrations folder
  at its head and its merge base, no longer from its file list. A pull request that changes 3000 files or more
  elsewhere (a code move) no longer counts as unreadable, so it no longer blocks `studio migration reserve` or
  makes `list` warn. A tree GitHub reports as truncated still fails closed.

## [0.23.0] - 2026-11-06

Cheaper on disk, one merge queue for every pull request, a register of migration numbers, a shared build
cache, more languages for comment proofs and project proof commands in a sandbox. Not tagged yet; the
maintainers tag after the merge.

### Added

- Clean-up of finished items: each tick removes the clone, crew home and tmp dir of an item that is merged (or
  dropped at least 7 days ago) once its crew is gone and every local branch tip is on GitHub (pull request head
  or main). Git never runs in the clone; anything unclear keeps it, with the reason. A clone whose report a
  pending lesson cites is trimmed to its report.
- `studio gc [--apply]`: lists those folders with sizes (`.git`, `target`, `node_modules` broken out) and
  verdicts; a dry run by default. `studio doctor` shows the clones' total size and how many can go.
- `studio merge <pr> [--repo owner/name] [--by <name>] [--follow-head] [--wait]`: hand a pull request without a
  board item to the merge queue. Only the head seen at `studio merge` is merged: a later push fails the entry
  ("head moved since enqueue"), unless `--follow-head` lets a new head merge once its own checks pass. It skips
  the branch update and Studio's approval (GitHub's branch protection decides), stops on the first failed
  check, waits while a push build runs on the base branch, re-reads the board and the head right before merging
  and merges with `--match-head-commit`. `--wait` reports `MERGED`, `FAILED` or `TIMEOUT`. `tick` pushes each
  result once. A pull request of a board item is refused.
- `merge.runner_load` in `studio.yaml` (`org`, `name_pattern`, `max_busy`, `samples`, `interval_s`): an optional
  gate before every queue merge on the busy self-hosted runners of an organisation; a failed read counts as busy.
- `studio queue` (`queue list`): the merge queue as JSON, external entries included, with a `status` per
  finished entry.
- Register of reserved migration numbers: `migrations: { dir, number_pattern, repo }` in `studio.yaml`, and
  `studio migration reserve [--number <n>] --for <who> --purpose "<text>"`, `studio migration list` and
  `studio migration release <n>`. Reservations live in the lead's state root under a lock. `collect` blocks a
  crew pull request, and the queue refuses to merge one (external entries included), when a new migration takes
  a number that is on main, reserved for someone else, or used by another open pull request. A list GitHub may
  have cut short counts as unreadable. Numbers that land on main are marked landed automatically. `studio
  doctor` shows the register.
- Shared build cache per project (`cache:` in `studio.yaml`, off by default; needs `roles.cache`). A crew of the
  new role `cache` builds `main` in a fresh, unseeded clone with no token; the guard limits it to the listed
  `cargo`/`pnpm`/`npm` commands and its report. Studio publishes the result copy-on-write into
  `<state root>/cache/` only for the launch it scheduled, at the pinned commit. Every other local crew starts
  from copy-on-write copies in its own clone and `HOME`. `tick` schedules a rebuild every `every_days` and keeps
  all caches below the owner's `cache.max_gb` (default 20) with a daily least-recently-used cleanup. `studio
  doctor` shows the cache and its size.
- `comments_only` reads Rust (`.rs`), TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`), JavaScript (`.js`, `.jsx`,
  `.mjs`, `.cjs`), YAML (`.yml`, `.yaml`) and TOML (`.toml`) besides SQL, chosen by file extension, each with a
  conservative tokenizer: comment markers in strings, raw strings, templates, regular expressions, JSX text and
  block scalars are content, and anything whose extent depends on context the tokenizer does not track proves
  nothing. Rust doc comments and comments that tools read (pragmas, lint and type directives, JSDoc tags,
  bundler hints) count as code. YAML compares every code line byte for byte and must also load to the same
  data. Shell and Python are left out on purpose: a script can read its own source and line numbers in too
  many ways, so for those files the proof does not apply.
- `proof: command` evidence rules: a command of the project (`command`, `timeout_seconds`) proves a property of
  a pull request by exiting 0 with the line `proven <nonce>`; the nonce arrives on file descriptor 3, never in
  the environment. Opt-in per machine (`allow_proof_commands: true` in the owner config), never without the
  proof sandbox: Seatbelt on macOS, bubblewrap on Linux, no network, no signals or process information outside
  its own sandbox, the base tree as cwd and the head as a read-only extract written blob by blob (no
  `.gitattributes` processing, links and submodules refused, a size cap), writes only in a private tmp dir, no
  access to the home, credentials, the owner and Claude config or the state, an allow-listed environment, CPU
  time, file size, wall clock and output limits. The rule and its script come from the base on the default
  branch only; a command that answered on a diff never runs on it again. A proof command must never execute
  head content. Elsewhere (native Windows, no bubblewrap) such rules prove nothing.

### Changed

- `--apply` works with `adopt` and `gc`; the usage error for other commands changed accordingly.
- A queue entry that ran out of the time limit is recorded with `timeout: true` (shown as `TIMEOUT`).

## [0.22.2] - 2026-11-06

Fixes from the owner's first real REA setup. Not tagged yet; the maintainers tag after the merge.

### Fixed

- The REA install failed with `npm view failed (exit 1)`: Studio set npm's user and global config
  both to `/dev/null`, and current npm (node 26) refuses that (`double-loading config "/dev/null" as
  "global", previously loaded as "user"`). The install now gives npm two distinct empty files in its
  staging folder (`.npmrc-user`, `.npmrc-global`, mode 0600, removed before the swap). The REA server
  wrapper (`bin/studio-rea-server.mjs`) does the same in the run's config folder, and
  `scripts/gen-rea-schemas.mjs` in its temporary folder. A new test runs the real npm (skipped when
  npm is not on PATH) with the install's environment; the earlier tests used a fake npm only.
- `studio doctor` said `known ones denied unless an item allows their class` also in trust mode (the
  default), where every class is open. It now says `all <n> known ones allowed (trust mode ...)` and
  names the mode on the `rea:` line; strict mode keeps the per-item wording. `deniedByDefault` in
  `--json` is 0 in trust mode; `knownTools` is new.
- `studio doctor` called a missing `research.artifacts` in `studio.yaml` a problem and pointed to an
  outdated step. Since 0.21 the grant is `research_roots` in the owner config and items name their
  folder with `studio add --artifacts`: doctor now reports how many research roots are granted (and
  how many are missing on disk; never their paths, `researchRoots` in `--json`) and treats
  `research.artifacts` as optional. Its advice, and the launch's, says REA installs on first use after
  one confirmation, or `studio setup research`.
- A crew that ended at once at the weekly usage limit was reported as `report file is missing ...
  studio stop --requeue` instead of a usage limit. Two causes: `tick` collected ended crews before it
  looked for limits, and the reset came only from the text (`resets Nov 7 at 7pm (Europe/Berlin)`),
  which Studio does not guess, so the label would have been parked for one hour. Now every tick, and
  `studio collect`, reconcile limits first; a limit is recognized by the structured fields of Claude
  Code's failed `result` and assistant API error message (`api_error: "usage_limit_reached"`, or
  `api_error_status: 429` with a rejected `rate_limit_info`), and the label is parked until the
  window's `resetsAt` (`seven_day` windows are the weekly limit). The item returns to `ready` with its
  one relaunch kept; with a credential provider the next launch asks it for another label. The owner
  and the lead see `usage limit on <label> until <time>; nothing launches on it` (time in the owner's
  zone; code `usage_label`, English and German), in the tick's `held`, on stderr, and in the pane and
  pushes as one owner line per parked label while other labels are free.
- Without a credential provider, a parked active account kept by Studio (`studio account`) now holds
  the plan like the parked default label; before, only `default` was checked there and the launch
  refused item by item.

### Changed

- Version 0.22.2.

## [0.22.1] - 2026-11-06

Fixes from the review before the handover: a project's state root can be moved, origins compare by
repository rather than by spelling, the board stays out of git, the board can be turned off per session
and in nested worktrees, the help covers every command, and a tick can be previewed. Not tagged yet; the
maintainers tag after the merge.

### Added

- `studio adopt --from <old state root> [--apply]`: brings the history of an earlier state root of the
  same repository (metrics, costs, lessons, the lessons review, the skills check, exceptions, releases,
  REA grants, the flaky ledger, CI reruns, acceptance runs, the contract record, the queue's merge
  history) into this project's state root. Owner only, in a terminal; refused for crews, for another
  repository, and while a crew is alive, a queue run or a tick holds its lock, or a merge is in progress
  in either root. A dry run without `--apply`; idempotent (append-only logs merge line by line, the queue
  history entry by entry, a differing JSON file is kept and reported as a conflict); never copies
  clones, crew records, logs, locks or per-run folders; never deletes the old root and prints the
  command to do it.
- `studio tick --dry-run`: what the next tick would do (collect, review items, launches with each
  researcher's REA decision, offers, queue adds and the queue run, a member's contract check, accepting
  epics, open releases, a due skills check, held and lead lines), read only: no lock, no state root bound,
  no fetch, no crew, no write, no push.
- `studio help`, with `--help` and `-h` as aliases, exits 0. The help is generated from one list
  (`src/help.ts`) and now names `setup research`, `research install --yes --folder`, `status --group`,
  `add --artifacts`, `epic edit --member`, `adopt`, `tick --dry-run`, `secret set worker-token` and the
  REA step of `setup`. A test holds it to the dispatcher's commands, the parser's options and the
  README's CLI table.
- `/studio off` and `/studio on`: the board off or on in this session only (pane, status line, toasts).
- `pane: { nested_worktrees: show | hide }` in the owner config (default `show`): with `hide`, a session
  in a git worktree nested under a Studio project starts with the board off; `/studio on` brings it back.
- `studio doctor` warns while git tracks `.studio/board.yaml` (`boardTracked` in `--json`).

### Changed

- The board is not committed: it is the lead machine's working state. `studio init --write` adds
  `/.studio/board.yaml` to `.gitignore` (created when missing) and its next steps say to commit
  `.studio/studio.yaml` and `.gitignore`; `studio.yaml` and `roles/` stay committed. The `gitignore`
  check warns only when `studio.yaml` or `roles/` would be ignored. The `studio:init` skill is unchanged:
  two baseline runs (`test/skills/baseline-lead.md`) followed the new next steps and committed
  `.studio/studio.yaml` and `.gitignore`, so no failing baseline exists for a change.
- `marker.json` origins compare by repository: `git@github.com:org/repo.git`,
  `ssh://git@github.com/org/repo`, `https://github.com/org/repo` and `https://github.com/org/repo.git/`
  are the same project (host lower-cased, login and port dropped, trailing slash and `.git` stripped,
  owner and repository case-insensitive on GitHub).
- README: the `workers.accept` example in the owner config uses `{ login, id }` entries; `studio setup`
  has six numbered steps, the sixth (REA) optional; the board section says where the board lives and
  that cross-project dependencies and group epics read the other project's working-tree board.
- Version 0.22.1.

## [0.22.0] - 2026-11-06

Localization done properly: one set of locale files for the pane, the `/studio` command, the pushes
and the notify command, a language is one file, and the whole interface works in English. Only
displayed text is translated; code, commands, codes, config keys and defaults stay English. Not
tagged yet; the maintainers tag after the merge.

### Added

- Locale files `hooks/locales/<code>.ts`, one per language, each `{ code, names, strings }`; English
  is complete and every other locale is merged over it, so a text a locale leaves out shows in English.
  The registry `hooks/locales/index.ts` is written from the folder (`pnpm locales`; `pnpm bundle` runs
  it), and the languages `/studio lang`, `notify.language` and the usage text offer come from it.
  English and German ship complete.
- One language chain for the pane and the pushes (`hooks/i18n/resolve.ts`): an explicit choice
  (`/studio lang <code>` or `notify.language`), then Claude Code's `language` setting (for pushes read
  from the project's `.claude/settings.local.json` and `.claude/settings.json`, then the user's
  `settings.json`), then the locale (`LC_ALL`, `LC_MESSAGES`, `LANG`; BCP 47 tags and POSIX locales
  such as `fr_FR.UTF-8`), then English. A language without a locale file means English.
- Codes for Studio's own lines that reach the pane, the toasts and the messages: owner lines
  (`forOwner[].code` and `params`), the holds of items and of the queue (`items[].wait.reason`), and
  the account block reasons and queue steps (already codes) are worded per language. The English text
  stays beside the code as the fallback and for the details view.
- The notify command gets `STUDIO_NOTIFY_LANG`, and `STUDIO_NOTIFY_TEXT` in that language.
- Tests: every locale covers every text or names what it leaves to English (`english`), a stub locale
  is picked up by adding its file, an unknown language falls back to English, the pane and the pushes
  resolve the same language from the same inputs, and snapshots of every English and German text.

### Changed

- Plurals by `Intl.PluralRules`, decimals and the cost by `Intl.NumberFormat`, and duration units per
  language (German `1h 5min`, `1T 2h`; the cost `3,46 $`).
- The `/studio` replies, the pane title, the command description and the REA confirmation toasts come
  from the locale files.
- `notify.language` accepts any shipped language code or `auto` (the default).
- `pnpm build` compiles `src` together with the shared texts in `hooks/` (into `dist/src` and
  `dist/hooks`).
- Version 0.22.0.

## [0.21.0] - 2026-11-06

Related repositories can now work as a group without becoming one project: each keeps its board, CI,
releases and approvals, and the owner config ties them together. A reviewer step can no longer hang a
review for hours. REA is simple to use: trust mode is the default, and it installs itself on first use
after one confirmation. Not tagged yet; the maintainers tag after the merge.

### Added

- Groups of related projects: `groups:` in the owner config (name, main project, projects with id,
  repository and folder, `reference` globs, optional `contracts` and `reference_max_kib`). Membership is
  matched by the folder's real path and checked against the repository its `studio.yaml` names; a
  repository cannot claim a group (`studio.yaml` refuses the key).
- A member's crews get the main project's contracts, decisions and glossary as a read-only excerpt beside
  the brief (`briefs/<id>.reference/`): read from the main project's freshly fetched `origin/main` at one
  commit, only the listed paths, plain files, no secret-like names, capped in count and size, cached per
  commit in the member's state root, marked as reference. A main project that cannot be read refuses the
  launch.
- Contract changes: each member's `tick` hashes the main project's contract files on `origin/main`; a
  change adds one check item (research, for the researcher or else the builder) to the member's board,
  idempotent by a digest note and crash-safe (board first, record second). `tick` prints
  `contractCheck`.
- Cross-project dependencies: `depends_on: [<project>:<id>]` waits until that item of another project of
  the group is merged. Read only, each board once per plan, fail closed (unreadable holds and goes to the
  lead, unknown refuses, a direct cycle is a cycle).
- Epics of the main project can hold member items (`studio epic edit <id> --member <project>:<id>`,
  saved as `member_items`); they count in progress and the epic accepts only once they are merged and
  readable.
- The group in the pane: `/studio group` draws one line per project and every project's decisions in one
  block; `/studio group <project>` opens that project's work list from its state file; German and English
  text, commands in English, counts on their own line in a narrow pane. `studio status --group <name>`
  prints the same (`--json` too). `state.json` carries `group`.
- Time limits for reviews: `review.analyzer_timeout_minutes` in `studio.yaml` (5 to 240, default 30) per
  analyzer subagent, and a session deadline of all analyzers plus one share. The guard records each
  subagent's start (`SubagentStart`, `agent_id`) and refuses its tool calls once its time is up, telling
  it to answer `skipped: timeout`; after the deadline only the report may be written. A mandatory analyzer
  that timed out refuses the approval, named as such (`mandatory analyzer timed out: ...`), and goes to
  the lead (`analyzer timed out – decide`); `tick` stops a reviewer still alive 15 minutes after its
  deadline (`review timed out`).
- REA trust mode, the default: `research: { trust: true }` in the owner config lets researcher crews use
  every REA tool class without `studio research allow`, and installs REA in full (optional dependencies
  and install scripts, still checked against the registry's integrity). The first launch that uses it
  prints one notice. `research: { trust: false }` keeps the strict behaviour.
- REA installs on first use: a researcher launch that finds the pinned version missing asks the owner once
  in a terminal (and for the analysis folder, default `~/analysis`, when none is granted); without a
  terminal the lead gets a decision the owner answers with a button in the Studio pane (the press writes
  the confirmation into the owner state) or with `studio research install` in their own terminal.
  Answers are kept per version and mode (`rea-consent.json`); a new version asks again; crews and the
  lead can neither install nor confirm.
- `studio research install [--yes] [--folder <dir>]`, `studio setup research`, and an optional sixth step
  in `studio setup` (asked once; a skip is kept).
- `studio add ... --artifacts <dir>`: a research item for the researcher with its own analysis folder,
  which must lie below a granted `research_roots` entry.

### Changed

- `studio research install` confirms (asked, or `--yes`, both only in a terminal) and installs in the
  mode the owner config asks for. A static install does not count for trust mode, and the other way
  round.
- `studio doctor` shows the REA mode (`trust` or `strict`).
- The board mod writes one file: the REA install confirmation, on a press of its button.
- Version 0.21.0.

### Fixed (review of the pull request)

- A subagent the guard stopped for time is appended to `guard/<id>.timeouts`; after any timeout
  `collect` refuses an approval unless every mandatory analyzer reads `skipped: timeout` and at least as
  many analyzers read it as subagents were stopped (subagent types are not trusted).
- The pane's REA confirmation is its own file (`rea-confirm.json`), never written through a link,
  taken in by Studio only when it is a plain file of the owner, not writable by others, whole, and
  names no folder but `<home>/analysis`. New research roots get the toolchain-path checks, must be a
  real folder of the owner and are stored by real path.
- Contract check items are deduplicated on the transition (`<group>@<from>..<to>@<sha12>`), so a
  revert gets its own item; changed paths go to the reference index as data, the Definition of Done
  is Studio's own text.
- The excerpt checks every path segment for secret-like names (more patterns, `secrets` and
  `credentials` folders) and leaves out paths that differ only in case, with a lead line; `cat-file`
  runs with `--no-replace-objects`.
- A crew's pull request that changes `.studio/board.yaml` gets no approval and goes to the owner.
- `reference/`, `contract-changes/` and `group-contracts.json` are protected state entries; a change
  file counts only for the item whose `contract-change:` note it matches.
- Dependency cycles are found across any number of projects (bounded walk).

## [0.20.0] - 2026-11-05

Some questions are answered by a shipped program, not by a source tree. The researcher role can now use REA
(reverse engineering) for that, read-only and static, and hands in structure, never content. Nobody else can:
the skill and the server stay denied to every other role. Not tagged yet; the maintainers tag after the merge.

### Added

- `research.artifacts` in `studio.yaml`: the one analysis directory a researcher's tools may read. Owner
  config: `research_roots` (the artifacts must lie below one; empty means no project can use REA),
  `rea_version` (the exact `x.y.z` of `rea-agents` crews run; default 6.7.0) and `rea_env`
  (`GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `REA_*` for the server). The path is checked like a toolchain path on
  its real path and may not be in the clone or the state root. The whole `research:` block of `studio.yaml`
  is the owner's for Studio's approval: a pull request that adds, changes or removes it gets none.
- `studio research install` (owner only, in a terminal): installs the pinned `rea-agents` once into the owner
  state, never with `npx` and never in a crew's clone. It takes the tarball's `dist.integrity` from the npm
  registry, runs npm without user or global config, tokens, install scripts or optional dependencies,
  accepts the install only when the lockfile names the registry tarball with that integrity, and records it;
  the earlier install is restored if the new one fails the launch check. Frida and the prebuilt
  pseudo-terminal binaries are left out (optional): the static tools do not need them, the debug and
  process-capture tools that do wait for a later opt-in with a pinned binary hash. A launch refuses unless the record,
  the lockfile and the installed package match the pin and nothing on the way is a link or writable by others.
- A researcher with REA gets one MCP server: Node by its absolute path running `bin/studio-rea-server.mjs`
  (shipped with Studio) on a spec file in the state root. The wrapper changes to an empty directory Studio
  owns and starts the installed package with a clean environment: `PATH`, `HOME`, `TMPDIR` and `XDG_*` in
  the run's own folder, npm config `/dev/null`, the `rea_env` names; no crew token or other crew variable.
  That folder, where REA copies what it analyses, is denied to the crew's shell and file tools and removed by
  `collect` and `stop`. Every other crew keeps an empty MCP list. The skill `reverse-engineer-anything` is
  offered to the researcher only (new matrix row) and denied by name to all other roles, whatever
  `studio.yaml` or a row says; a researcher without a configured directory is denied it too.
- A tool allowlist, enforced by the guard (default deny, exact tool names) and mirrored by deny rules in the
  settings: static, read-only tools only. The classes `annotate`, `debug`, `observe`, `device` and `export`
  stay denied unless the owner opens them for one item with `studio research allow <item> <class>` (in a
  terminal, refused for crews; `research revoke` and `research list` beside it), kept in the project's state
  root, never on the board; the shell tools of a class (`gdb`, `frida`, `adb`, `tcpdump`, ...) follow the
  same grant. Arguments are checked: only the argument names a tool's schema lists; every path argument and
  every path-like value absolute, in the analysis directory as written and on its real path (never the
  clone, never relative), and so is every nested argument named like a place, whatever its value; write
  arguments by the words of their name (`left_export_name` is none), any value but unset, null, false or
  empty refused, numbers only for limits; databases by schema only; `inspect_recorded_crash` with `include_debugger_context` only with
  `debug`.
- `scripts/gen-rea-schemas.mjs` generates `src/rea-schemas.ts` from the pinned server's tool list, type-aware:
  only string arguments name a place or hold free text.
- Bash never touches the analysis directory: it is in the sandbox's `denyRead` and `denyWrite` for every shell
  process, Read, Grep and Glob are refused by the guard, and a command naming it gets an early refusal. Only
  the REA tools, which run in the MCP server outside that sandbox, reach it.
- A privacy check at `collect` for every crew field of a researcher's report (pull request title and
  `not_run_here` lines included) and for everything its branch adds over `base...head`, read in the owner's
  checkout (emails, phone-like numbers, personal fields, rows, card and account numbers, credentials;
  binary, very large, linked or unreadable files, lines over 4,000 characters): one hit rejects the report
  and hands it to the lead with kinds and lines, never the text. Studio checks the pushed branch before it
  opens a researcher's pull request, opens none on a hit and closes one that exists.
- The brief of such a researcher: the scope, the classes opened, target content as data (injection attempts
  are reported by kind), the result as structure and where findings go (`docs/research/<id>-<slug>.md`).
- `studio doctor` shows the REA pin and who set it, whether it is installed with its integrity, whether the
  analysis directory is allowed, the skill in the crew config dir, the server registered there, the engine
  variables set (names only) and the setup command.

### Changed

- A `type: research` item pushes nothing: the guard refuses every `git push` of it, and its crew gets no
  GitHub token.
- The guard context may carry `mcpAllow`, `artifacts`, `reaClasses`, `blockedCommands` and `noPush`; a crew
  without them is unchanged.
- Items that run on a worker get no REA yet.

## [0.19.0] - 2026-11-05

Some work needs another machine: real hardware, an installed program to analyse, another operating system.
Until now the lead steered such a session by message. Now an item names a worker label (`runs_on`), the lead
offers it on GitHub, and `studio worker --label <label>` on that machine claims it atomically, runs its crew
under the same rules as a local crew plus a deny list of places and ports, opens the pull request with its own
identity and hands the report back on the claim. The lead collects, reviews, queues and merges as before.
Nothing but GitHub is shared between the machines. Not tagged yet; the maintainers tag after the merge.

### Added

- `runs_on: <label>` on a board item (`feature`, `fix`, `chore`, `docs` or `research` of a builder, designer
  or researcher). `plan` lists such items under `offer`; `launch` refuses them. Offers take no role WIP, no
  credential slot and no host load; dependencies, overlaps, component WIP, a pause, an account block and the
  daily cost cap hold them.
- `tick` offers each planned one as an issue `Studio offer <id> for <label>` (label `studio-offer`, the item's
  board fields and a nonce as one JSON block, locked at once so only collaborators can comment), moves it to `assigned` with the crew `worker:<label>`, follows its claim
  (`in_progress` while claimed, `held` with `worker: ...`), collects a `done` claim through the same `collect`
  and blocks the item on a `released` one; `tick` prints `offered`. The offer record lives in `workers.json`.
- Claims: `refs/studio/claims/<id>` on the primary repository, created through the GitHub API (one creator
  wins), moved only as a fast-forward from the commit the worker wrote last (heartbeat every third of the
  lease, default 30 minutes), taken over after the lease plus two minutes (counted from when the lead or the
  worker first saw that claim commit, on its own clock, never from commit dates) by another worker of the label,
  once (attempt 2, from the pushed `studio/<id>`); a second expiry goes to the lead.
- `studio worker --label <label> [--once]`: claims one offer at a time, launches the crew with `launch`'s code
  (the brief entirely from a fresh `origin/main`: rules, `studio.yaml`, role text, lessons and solutions;
  sandbox, guard, skill allowlist, its own Claude account and limits), opens or renews its own pull request
  in-process with the worker's token (never one of another account or a fork), and writes the claim `done`
  with `report.md` and `usage.json`, or `released` with a fixed reason. Its state is `worker.json`; after a
  restart it first goes on with the item it holds (its own heartbeats on top of what it saved count as its
  own), then checks for new claims. A claim it cannot start (comment failed, offer closed, launch refused)
  is removed again, never `released`; a launch held back tries again later.
- Before every claim the worker checks that it can enforce its rules and refuses otherwise: a sandbox
  (macOS, Linux, WSL2 with interop off, read again each time; native Windows, WSL1 and an unclear WSL version
  refuse), an owner config `workers.self` naming the lead, a token that is not the lead's, every pinned plugin
  installed at its pin (stricter than a local launch: a plugin that is not installed refuses), no account
  block, a credential neither parked nor at its limit, no launch in progress, no pause, and a deny list the
  sandbox can hold.
- Deny lists: `workers.<label>.deny` (`paths`, `ports`) in `studio.yaml`, joined with `workers.self.deny` of
  the worker's owner config. Paths go into the sandbox's `denyRead` and `denyWrite` and the guard's secret
  paths; a Windows drive path holds only under WSL2, as the whole drive. On WSL2 the automount root and every
  drvfs, 9p or virtiofs mount are denied by default; `workers.self.allow_read` opens single places for reads.
  With ports denied, a `sandbox.network_allow` entry that could reach the machine (an IP address in any
  spelling, `localhost` without a port, `*`, single-label or local names) refuses, judged after the host is
  normalised (lowercase, one trailing dot dropped, WHATWG URL host parsing); an entry that does not parse
  refuses too, and a wildcard over an IP address (`*.<address>`) is refused already when `studio.yaml` loads. The guard denies commands that name a denied port.
- `workers.accept` in the owner config on the lead's machine: the accounts whose claims count, per label, each
  as `{ login, id }`; the numeric id is what is compared, since a login can be reused. An accepted account
  that is the lead's own crew token account refuses the offer.
- The lead's checks: the claim ref is only the lock. Each claim (and each takeover) is proven by one comment on
  the offer, `studio-claim <claim commit> <offer nonce>`; the first unedited one for the commit that started the
  attempt must come from the account the claim names, accepted for the label; every later state change (`done`,
  `released`) is announced the same way, naming its exact commit, and only heartbeats may stay unannounced.
  Only unedited comments by OWNER, MEMBER or COLLABORATOR accounts with an accepted id count; others are
  warnings and never decide or block, and an offer with more comment pages than Studio reads decides nothing.
  The chain walk stops at the tip the lead proved before. Nothing in a commit
  (content, author, committer, signature) counts. Unproven claims, unannounced state changes and edited
  comments go to the lead.
  The pull request must come from `studio/<id>` of the item's repository with the report's head, opened by the
  claiming worker's account id. The worker token needs Issues: Read and write for the comments.
- Two tokens on a worker: `worker-token` (`studio secret set worker-token`) for claims, pull requests and pushes,
  used in-process (HTTPS from Node, not `gh`), never handed to a crew, refused when it equals the crew token or
  its account is the crew token's (`GET /user`); the crew gets at most the crew token. Without one, the crew
  commits only and the worker pushes `studio/<id>` from a fresh blob-less clone after it ended.
- The guard refuses crew pushes to `refs/studio/*`, also as a short name git would resolve there.
- README: a ruleset for `refs/studio/claims/*`, marked untested and not a control; anyone with contents write can
  deny a claim, not forge one.
- A report or pull request text that looks like a credential, or holds the worker's own tokens, is never
  published: the claim is `released`.
- Costs: a worker's run counts once, first in the day's ledger and then on the item (`usage`, from
  `workers.json`); while the ledger does not take it the item waits. One run counts for at most the lowest
  daily cap.
- `studio status` lists offers as `worker:<label>` rows (`--json`: a `worker` object with label, offer, login,
  claim state, attempt and last heartbeat); the pane shows the wait code `worker` in English and German.
- `studio stop <id> --requeue` on an item on a worker withdraws the offer (the worker stops its crew) and gives
  the item its one relaunch; `studio drop` withdraws it too.
- Verification fixes:
  - The lead locks an offer it reuses, too, not only one it opens.
  - Transient launch refusals (account block, pause, parked or full label) are `HeldError`: a worker holds and
    tries later instead of exiting. An offer let go of after a held launch (5 minutes) or a refused one (an
    hour) is not claimed, nor commented, again in that time.
  - A `done` or `released` commit is announced durably: the commit waits in `worker.json`, is tried again with
    backoff on later passes (looking for its own comment first) until the comment exists.
  - Giving up a takeover resets the ref to the previous attempt's tip, only while it still is the worker's own
    commit, so the attempt count is not used up. The lead gives a claim commit about 2 minutes for its comment
    (ref written, comment not there yet; done written, not announced yet) before it goes to `needsLead`; that is one window per offer, counted from the first unproven tip and reset only by a proven claim, so neither new tips nor their attempt numbers restart it (an attempt number that goes down gets none), and it never replaces what the lead proved before.
  - The whole brief comes from one `origin/main` commit: the project rules and the crew's start use the SHA the
    worker pinned.
  - The worker tells the lead by numeric id (`workers.self.lead_id`), compares logins without case, reads the
    crew token's name from the pinned `studio.yaml`, keeps the claim beating (and the worker lock fresh)
    during the push and the pull request, and holds its lock for up to three hours.
  - WSL interop counts as on when either `WSLInterop` or `WSLInterop-late` is enabled.

### Changed

- `openCrewPr` moved to `src/pull-request.ts`; it no longer reuses a pull request from a fork.
- The lessons evidence may name a report on a claim (`refs/studio/claims/<id>@<sha>`).
- `recover` leaves items on workers to `tick`: they have no crew record by design.

### Not covered yet

- No Windows programs, builds or device tools on a worker: they would run outside the sandbox. They stay on
  the CI's Windows runner.
- Not run against GitHub or on a real Windows machine: the GitHub calls are tested against a fake with the
  same create and fast-forward rules, the WSL detection against sample files.

## [0.18.0] - 2026-11-05

A release was the lead running the project's deploy workflow by hand: no note said what went out, a destructive
migration went with one announcement line and no approval, a part a third party owns needed their word with no
place to record it, and nothing watched the checks after the deploy. Now `studio release <component>` drafts the
note, logs the announcement, collects the owner's and third parties' approvals through the lead, starts one named
workflow once, and stops on a red check with the way back shown. Not tagged yet; the maintainers tag after the
merge.

### Added

- `release:` per component in `studio.yaml`: `workflow` (a file below `.github/workflows/`, with
  `on: workflow_dispatch` and an input `sha`), `post_checks` (jobs by workflow file, at least one), `migrations`
  and `config` (globs), `rollback` (`text` or `workflow`), `approvers` (`id`, `who`, optional `for` and `paths`)
  and `timeout_minutes` (default 60). A block with `command`, `run`, `script`, `skill` or `steps` is refused, so
  is a release, post-check or rollback workflow that `crew_allowed_workflows` lists, and a component with a
  release named `list`, `show`, `approve` or `cancel`.
- `studio release <component> [--dry-run] [--since <commit>]`: the first call drafts the note from the
  commits since production's (the last release that deployed; `--since` for the first) and logs a one-sentence
  announcement (what is deployed and what cannot be undone); the next call triggers, once the approvals are in;
  later calls follow the run. `--dry-run` prints the draft and writes nothing.
- The note: the component's merged board items in the range grouped by epic, migrations in natural order with
  kind (`additive`, `destructive`, `backfill`, `unclear`) and risk, configuration names added or removed in the
  `config` files (never values), the way back, the post-deploy checks and the approvals needed.
- Migration kinds from the SQL tokenizer of 0.17 and an allow-list of exact statement shapes, no parser: only
  `additive` is low risk, and only a statement that matches a shape from its first token to its last is (plain
  `CREATE TABLE` columns with literal defaults, `CREATE INDEX` on columns, `ALTER TABLE ... ADD COLUMN`, enums,
  schemas, sequences, `ALTER TYPE ... ADD VALUE`, `COMMENT ON`). A query, copy, partition, computed or
  non-literal default, call shape, trigger, rule, function or `DO` block is `unclear`; anything not additive
  needs the owner, also a non-SQL file, a changed or deleted migration, and any other `.sql` or
  migration-looking file of the component outside `migrations`.
- Approvals: `studio release approve <id> owner --said "<words>"`, owner only, in a terminal, for migrations that
  are not clearly additive; `studio release approve <id> <approver> --by "<who said it>" --said "<words>" --at
  <time>` for a third party, recorded by the lead from what the owner relays (Studio contacts no one). An
  approval binds to one release; its time may not lie before the announcement or in the future; text shaped like a
  credential is refused.
- The trigger: `gh workflow run <id> --ref <default branch> -f sha=<release commit>`. First Studio must not be
  paused and CI must be within `merge_max_busy` (two reads); then the commit must still be on the default
  branch, the workflow files at the head must be the blobs pinned in the announced record and declare the
  input, the migrations must read as they did when announced, and no `crew_allowed_workflows` entry may resolve
  (by id, file or display name, as gh does) to the release, a post-check or the rollback workflow; then the head
  is read once more and must not have moved. Recorded before gh runs: a trigger without a known run is looked
  up (the one dispatch since the trigger), never repeated. Only an HTTP 4xx from GitHub fails it as "nothing was
  deployed"; a timeout stays triggered and is looked up. The release run must be of the checked head.
- After the deploy: the release run, then each post check (a job of the release run, or of another workflow
  Studio starts once, recorded first, under the pause and capacity rules, with the pinned file, its run held to
  the head it was started at). Several candidate runs fail closed at the timeout. A failed or missing job, a run of another workflow or event, and no result
  within `timeout_minutes` stop the release (`failed`) with the way back in `needsLead` for a day; Studio runs
  nothing back. A passed release run is a `deployed` metrics event with its release.
- `studio release list`, `studio release show <id>`, `studio release cancel <id> --reason "<line>"` (before the
  trigger only). `tick` follows triggered releases (it never triggers), lists `releases`, and puts `release
  approval: ...`, `release failed: ...` and `release unknown: ...` lines into `needsLead`; it pushes a fixed phrase
  for each announced release and each approval or red release to the owner's phone. `studio board` lists open
  releases, `state.json` and the pane's details view those of the last seven days, with the status in words
  (English and German).
- `releases.json` (under `releases.lock`, which `recover` checks) and the log `releases.jsonl` in the state root;
  both are among the files crews must not write.

### Changed

- A pull request that changes a component with a `release:` block (its whole entry), a workflow such a release
  starts or names, or `crew_allowed_workflows` while a release exists gets no approval from Studio, like one
  that changes `evidence:` (`approval refused: ...; the release rules are the owner's: ...`).
- Approver `paths` are matched against every change of the release, not only the component's.
- `release.guarded_paths`: files outside `.github` the release workflows run (deploy scripts). Once any
  component has a release, everything below `.github/` and the guarded paths are owner-owned: a pull request
  that changes one, or adds a link or submodule there or on the way there, gets no approval. A link or
  submodule inside that scope refuses a draft or trigger. The announced record pins the tree
  of `.github` and the guarded files; the trigger refuses when either changed at the release commit or the
  head. The owner must list such scripts; Studio does not find them.
- From the adversarial review: all of `studio.yaml` but `stacks` is owner-owned while a release exists
  (compared camelized; a key in two spellings is refused when the config loads); a release run must have an id
  above the workflow's newest run before the dispatch, and nothing starts while a run of it is queued or
  running; a release that failed with an unknown outcome blocks the next draft until `studio release resolve
  <id> --deployed|--not-deployed --reason "<line>"`; a workflow Studio starts may run on `workflow_dispatch`
  only and must use `inputs.sha`; post-check starts run the trigger's checks; `crew_allowed_workflows` counts
  from the release commit, the head and the live config; the release command pushes the announcement itself
  (urgent), records `notify`, and the trigger waits a tick or 5 minutes after it; migrations: an index without
  `CONCURRENTLY`, a `NOT NULL` column without default and a serial or identity column are `unclear` with a
  `lock` or `fails_on_data` risk shown in the note and the announcement, directive comments, transaction
  statements, non-ASCII whitespace and a keyword as column name make a file `unclear`, `ALTER TYPE ... RENAME`
  is called lossy; approvals are kept verbatim (refused when too long or multi-line, never cut); items beyond
  200 are listed as not placed; schema-looking files outside `release.migrations` are warned about; only gh's
  exact refusal shape fails a dispatch as not deployed; the repository may hold no symbolic links or
  submodules while it releases.
- The rollback workflow is pinned like the started ones: the trigger refuses another, and the pin is checked
  again before the way back is shown (`needsLead`, `release show`); a changed one is not offered.
- The lead skill: a Release section (send the announcement word for word, approval lines are owner lines, never
  approve a migration or contact a third party, the second `studio release` call triggers and `tick` never does,
  never `gh workflow run` or `deploy record` a release, the way back after `release failed` is the lead's). A
  destructive migration in a release is the owner's now; outside a release it stays the lead's.
- `--dry-run` works with `release` too; `--reason` with `release cancel`.

### Not exercised

- A real release workflow on GitHub: `gh workflow run` printing the run's URL, the dispatch lookup, a real
  post-deploy job, a real rollback. A lead session running a release over hours. The note across hundreds of
  commits.

## [0.17.0] - 2026-11-05

A guard job in CI (a migration guard, a floor guard) that flagged a harmless change stopped the pull request
until a person waved it through, even when the change was mechanically "only comments". Now a project binds
such a guard to a built-in proof in `studio.yaml`; when the proof holds on exactly that diff, the failed
checks count as waived and the exception is logged with its evidence. Without a proof the lead decides; only
an `owner_only` rule goes to the owner. Not tagged yet; the maintainers tag after the merge.

### Added

- `evidence:` in `studio.yaml`: rules with `id`, `guard` (the CI job by workflow file and job name),
  `proof`, `paths`, `languages` (for `comments_only`) and `owner_only`. The proofs, computed by Studio in
  TypeScript, with no command run:
  - `comments_only`: every changed file lies under `paths` and is a `.sql` file in which only plain
    comment text was edited, added or removed. PostgreSQL only; `sql` is the only language so far, and a
    rule naming another is refused.
  - `paths_only`: every changed path, both sides of a rename, matches `paths` (case-sensitively).
- A conservative SQL tokenizer, PostgreSQL only, linear in the file size, over the exact bytes of base and
  head: strings with doubled quotes, quoted identifiers, dollar quoting with ASCII tags, positional
  parameters, line and block comments. Not proven: invalid UTF-8, a backslash, a lone carriage return, a
  form feed or vertical tab, mixed or changed line endings, `--` without a blank after it, nested block
  comments, executable comments and hints (`/*!`, `/*+`, any `/*` not followed by a blank or `*`), a
  backtick, a `$` that is no clean tag or parameter, anything unterminated. A line comment always ends a
  line, so code is never joined across one. Comments with a meaning (migration and query directives, tool
  names) must be byte-identical and in the same place, each judged on its own. An added, deleted or
  renamed file, a mode change, a symlink, a submodule, a binary file and a path with a control character
  prove nothing. The diff comes from git with pinned options.
- Rules count only from `studio.yaml` at the pull request's base commit on the default branch (and only
  while the owner's checkout has rules at all). A failure applies to them only when every failed check is a
  plain failed job of a rule's guard, and the guard must be the same at base and head.
- `exceptions.jsonl` in the state root: an append-only log of each proof's result (`applied` or
  `not_proven`) and of grants, with rule, guard, pull request, item, base, head, a digest of the diff, the
  proof and why, or the grant's reason; logged once per rule, pull request, base and head under
  `exceptions.lock`. An unreadable pull request or file is retried, unlogged, and after 5 tries per head
  (`evidence-retries.json`) goes to the lead. `recover` breaks a stale `exceptions.lock`.
- `collect` of an approval and the merge queue use it: waived checks count neither as failed nor as passed.
  The queue judges again right before the merge and reads the base commit once more immediately before it
  merges; a moved base is judged again. `collect`, `tick` and `queue run` print `exceptions`; `studio
  board` lists those of open items, the pane's details view those of the last seven days (`Exceptions by
  evidence`).
- Without a proof, one line for the lead (`evidence: <job> failed on <repo>#<n> at <head> and no evidence
  proved a false alarm (<rule>: <why>); decide: ...`): the approval waits, or the merge fails. These lines
  are not pushed to the owner's phone; the pane shows them as `guard hit without evidence – decide`. A guard
  with an `owner_only` rule makes it `evidence (owner): ...`, which is pushed.
- `studio exceptions [list]` and `studio exceptions grant <repo>#<pr> <rule> --reason "<line>"`: the lead's
  decision, bound to the current head and base (`by: lead`). A guard with an `owner_only` rule, through any
  of its rules, and an `owner_only` item take the owner's, in a terminal (`by: owner`). Refused under
  `STUDIO_ROLE=crew`. The lead is trusted here: `owner_only` guards against its mistakes, not against a
  compromised lead.
- A pull request that changes `evidence:` in `studio.yaml` gets no approval: the review item is blocked,
  the owner reviews and merges such a change himself. Checked for every approval from `studio.yaml` at the
  base; the approval waits when that cannot be read.
- The review routine names the guard jobs Studio judges by evidence: a failure of one alone is no finding.

### Removed

- The reviewer's offered skill `pr-review-toolkit:review-pr`. It is a command of Anthropic's official
  marketplace (Apache-2.0) that no crew config dir installed, so every large review reported it under
  `skillsMissing`. Installing it would add a third marketplace to every crew for a workflow that runs
  `gh pr view` (the reviewer may not run gh) and starts its own agents without an explicit model, and that
  duplicates the gate's own analyzers.

### Not in this version

- `whitespace_only`: a rule that names it is refused. It comes later.
- `comments_only` for other languages than SQL. They come later, each with an adversarial review of its
  own.
- Custom proof commands. A rule with `command`, `run` or `inputs` is refused: they come later, with a real
  sandbox model.

### Not exercised

- A real guard job on GitHub, a real lead deciding on a hit, and a guard that branch protection requires
  (GitHub then refuses the merge whatever Studio waives).

## [0.16.0] - 2026-11-05

An epic whose items were all merged sat in `accepting` until someone looked: nothing ran the E2E and
browser suites on main, which no crew sandbox can run, and nobody read the epic's pull requests together.
Now Studio adds an acceptance item, waits for the full suites on main, has a reviewer crew check the
combined diff against the acceptance lines, turns each finding into an item of the epic, and marks the
epic done only when the acceptance is green. Not tagged yet; the maintainers tag after the merge.

### Added

- The acceptance item: once an epic is `accepting`, `tick` adds `Acceptance of E-<n>: <title>` (`review`,
  role `reviewer`, `triggers: [epic-end]`, the acceptance lines as its Definition of Done, `epic: E-<n>`,
  notes `acceptance E-<n>` and `acceptance-state: <hash>`). One per epic state: never a second while one is
  open or one finished for the same items; a dropped one is replaced. It does not count in the epic's
  progress and does not reopen it. One that has not started is dropped when its epic moves on.
- `acceptance: { suites: [{ workflow, job }] }` in `studio.yaml`: the full suites, each workflow by its file
  (`.github/workflows/<file>.yml`) and found by GitHub's id, never by display name. Every run on the commit
  counts and a red one wins; a file listed for two workflows fails closed. Without it every workflow run on
  the main commit counts, by file, except one skipped there. Before the launch phase `tick` reads them on the head of the default
  branch, waits on that commit until all completed (`held`), then pins it (`acceptance-main: <sha>`); the
  planner defers the item until then (`ci pending`). A configured suite with no run there is started once
  with `gh workflow run` after 10 minutes, recorded in `acceptance-runs.json` before gh runs; a suite
  cancelled or skipped there gives way to a newer head; what cannot be resolved goes to `needsLead`.
- The acceptance review: the reviewer loads main at the pinned commit and gets the suite results and the
  epic's pull requests with their merge commits and files as data files. Its brief has an acceptance
  routine (coherence across the pull requests, gaps against the acceptance lines, the epic-end full scan
  over the combined diff, no mutation probe owed) and its own report shape: `verdict`, `accepts: E-<n>`,
  `head_sha`, `analyzers`, `findings`.
- `collect` of an acceptance holds the report to its launch record (epic, state, main, suites) and, in the
  same board save as the item's move, adds one `fix` item per finding (`E-<n>: acceptance finding <k> of
  <id>`, a fixed Definition of Done, note `finding of <id>`; the finding text is kept in the new item field
  `finding` and reaches the builder only as a data file) and per failed suite (a configured name quoted,
  any other name as data), which reopens the epic, or marks the epic `done` with
  `accepted: { item, sha, at }`. From the third round that found work (whatever the verdict), new items wait `blocked` for
  the lead. `epic drop` takes a waiting acceptance along. It prints
  `acceptance: { epic, result, findings }`; `tick` prints `epicsDone`, `epicsReopened` and `acceptance`
  (items added, dropped, pinned, suites started), and `epicsReady` names the acceptance item.
- Epic stages: `open`, `in acceptance`, `done`, `reopened` (open again after accepting). `studio board`
  lists each epic's stage, progress and acceptance item below the items; `epic list` has an `ACCEPTANCE`
  column and shows the stage, `epic show` the acceptance; `state.json` epics carry `stage` and
  `acceptance` and include epics done in the last day; the pane names the stage; the roadmap adds
  `· in acceptance` or `· reopened`.

- An epic that is already `accepting` from an older Studio gets its acceptance item on the first tick of
  0.16. An imported epic whose acceptance is still the placeholder gets none: `needsLead` says
  `define acceptance first`.
- Without `acceptance.suites` a main commit with no CI run is never accepted: after 10 minutes the lead is
  asked to configure the suites or rerun CI. `acceptance: { suites: [] }` opts a repository without CI out.
- When the round limit holds an epic, `tick` adds `acceptance limit reached for E-<n>` to `needsLead` and
  `held: true` to its `epicsReopened` entry.

### Changed

- A tab or line break in a crew reason (a `not_run_here` reason, an acceptance finding) becomes a space
  instead of rejecting the report.
- The lead skill: the acceptance is Studio's and the reviewer crew's; the lead never runs the suites,
  reviews the epic or sets it done by hand, acts on acceptance lines in `needsLead`, and tells the owner
  once per epic when it is done.

### Not exercised

- A real acceptance crew on a real epic, `gh workflow run` against GitHub, and an epic across several
  repositories (the acceptance runs in one of them and lists the others' pull requests).

## [0.15.0] - 2026-11-05

Lessons crews proposed piled up until someone looked, and after a crash or a restart the control room
had no explicit way to tell what was cut short. Now the lead reviews proposals in a weekly batch, and the
next tick (or `studio recover`) picks up the thread without starting or merging anything twice. Not
tagged yet; the maintainers tag after the merge.

### Added

- The weekly lessons review: once in 7 days `tick` (or `studio lessons review --now`) folds near-identical
  proposals of a role (same text once case and punctuation are ignored) into the oldest, then adds one
  board item per role with pending proposals, `Review crew lessons for <role> (<n>)` (`chore`, role
  `researcher`), naming the proposals by number only. The planner never assigns it (`lead work`, under
  `held`, no push): `lessons accept` is the lead's. `tick` prints `lessonsReview` for open ones and
  `lessonsJudged` when it closes one, as merged, once each of its proposals was accepted, dropped or folded.
- `studio lessons drop <n> --reason "<line>"`; verdicts and reasons are kept in `lessons.json`.
- A proposal stores the report and the pull request of its run as evidence; `studio lessons` shows each
  with its age, source item and evidence.
- `studio recover [--dry-run]`: lists held and stale locks and breaks the stale ones, removes leftovers of a
  cut-short write or lock break, finishes an interrupted launch on the board, and reports ended crews,
  items without a crew record, an interrupted queue run and queued items the queue lost. It prints
  `findings` and `needsLead`; `--dry-run` only reads; a second run does nothing.
- `tick` runs the restart checks first (`recovered` in its output when something was repaired).

### Changed

- Locks record the holder's process start time: a lock whose pid now belongs to another process (after a
  reboot) is stale at once. A live holder whose start time matches is never broken, however long it was
  silent; one that cannot be verified is taken over only after a very long silence (four times its limit,
  at least an hour). `recover` reports a quiet live holder (`silent <n> min, holder alive`).
- A queue run whose lock was taken over stops before its next step; a launch beats its lock around the
  clone.
- `crew.json` is changed only under `crew.lock` (launch, stop, usage limits, account blocks), and an
  unreadable file is never replaced.
- The interrupted-launch repair waits while a launch holds the launch lock and while a record without its
  start time is younger than 2 minutes; a launch whose item was already moved to its crew succeeds.
- An item in review that the merge queue already holds is moved to `queued` (a `queue add` that stopped
  between the queue entry and the board).
- `collect` stores lessons before it moves the item. The hint for an item without a crew record checks
  its log first.
- `costs.lock` is among the locks `recover` checks; the state files crews must not write include the
  lessons files, `tick.lock`, `board.lock` and `crew.lock`.
- `launch` writes the crew record with its pid right after the start and adds the start time once read, so
  a lead killed in between leaves a record (unverified, never signalled) instead of a crew nobody knows of.
  A `ready` item with a crew started for it is moved to `assigned` by the next tick, never started again.
- `lessons.json` is changed under its own short lock (`lessons.lock`).
- The lead skill: after a restart `studio recover`, then the heartbeat; the lessons review is the lead's
  item, with one owner line per role ("<n> lessons accepted for <role>").

### Not exercised

- A real reboot with live crews, and a real lead session working a lessons review item.

## [0.14.0] - 2026-11-05

What crews cost was invisible, and nothing kept a busy day from running up. Now each item shows its runs,
tokens and cost, and a daily cap per project and per owner stops new launches once it is reached. Not
tagged yet; the maintainers tag after the merge.

### Added

- Costs per item: `collect` reads the `result` events of the crew logs (`total_cost_usd`, else the sum of
  `modelUsage[*].costUSD`; tokens from `modelUsage`, else `usage`) and stores
  `usage: { runs, tokens_in, tokens_out, tokens_cache, cost_usd }` on the item, with the reviews of its pull
  request counted for the builder item. Recomputed from the logs, never added twice.
- `studio metrics` prints `costs` (today, per item, per epic); `studio epic list` has a `COST` column
  (`costUsd` in JSON); the pane's footer shows `today $n`; `state.json` has `today.costUsd`.
- Daily cost cap: `limits.daily_cost_usd` in `studio.yaml` (one project) and in the owner config (all
  projects). Ended runs go into `costs.json` in the state root on the owner's local day; once the cap is
  reached every ready item is deferred with `daily cost cap reached ($x of $y)`, `tick` lists it under
  `held`, running crews finish, and the next day starts from zero. Under an owner cap every project's
  ended runs are entered first, also of a project without a tick. A run counts as ended only by its
  process identity, a launch records the item's previous run before it replaces the crew record, and
  `accounts-clear` records runs before it moves their log start. Writers take `costs.lock`.
- A run without a `result` event is estimated from its assistant usage (by model family, unknown
  models at the highest rates) and marked `estimated` on the item and in the ledger.

## [0.13.0] - 2026-11-05

Decisions waited until someone looked at the board, and a flaky test anywhere in the repository failed
an unrelated pull request in the queue until the lead reran it by hand. Now Studio pushes a decision to the
owner's phone, and a failure outside a pull request gets one rerun on its commit. Not tagged yet; the
maintainers tag after the merge.

### Added

- Push notifications through ntfy, no account needed. `studio setup` has a fifth step, also on its own as
  `studio setup --notifications`: ntfy or none. ntfy makes a random topic (144 bits), prints the subscribe
  link once, sends a test push and stores the topic only after it went out (`notify-secret` in the owner
  config dir, mode 0600). `notify.ntfy_server` in the owner config points to a self-hosted server.
  `doctor` shows `notifications: ntfy | none | invalid`, never the topic.
- `tick` pushes each new `needsLead` entry and every account block: one line, a fixed phrase in English or
  German (`notify.language`, else the locale), the item id and the project name, never crew text. Each
  decision is pushed once; at most one push per project in 10 minutes, the rest bundled; quiet hours
  (`notify.quiet: "22:00-07:00"` in `notify.timezone`, else the system zone) hold pushes back, except an account block, which is
  urgent. A failed push is a `notify:` line under `errors` and is retried; it does not change the exit code.
- A failed check outside the pull request (the job runs in a directory of its own that the pull request
  and the item do not touch) gets one rerun of its failed jobs on the same commit
  (`gh run rerun <run> --failed`), once no check of the pull request still runs and CI is under the merge
  capacity. The queue and `collect` wait for it. A pass goes into the flaky ledger (per repository); a
  failure of the same job in the same repository within 14 days of a rerun that passed adds one item
  `Find the cause of flaky <job>`. Never more than one rerun per commit (`ci-reruns.json`); a rerun
  GitHub refuses for now (still running, 403, 422) does not use it up.
  Anything Studio cannot place counts as related and fails as before.
- `tick` prints `reruns` and `flakyItems`; `queue run` prints them when there are any.

### Changed

- The lead skill: pushes and flaky reruns are Studio's; the lead acts on `needsLead` as before and no
  longer records Studio's own reruns in the ledger.
- `primary_repo` and `repos` in `studio.yaml` must be `owner/repo`.
- The owner config's `notify` block takes `quiet`, `timezone`, `language` and `ntfy_server`; `channel` and `command`
  (the notify command of `studio state`, unchanged) are optional now, but go together.

## [0.12.2] - 2026-11-05

Every Studio update moves the pinned version of the `studio` plugin, and until `setup-plugins` ran,
no crew could start. It needed the owner in a terminal, so each patch release stopped all crews until the
owner came by. Not tagged yet; the maintainers tag after the merge.

### Changed

- `studio account setup-plugins` no longer needs a terminal. It handles no secret, installs only the
  pinned defaults and the owner-config allowlist, and still refuses crew sessions. The lead skill
  runs it when a launch is refused for a moved pin.

## [0.12.1] - 2026-11-05

From a real run: a builder crew finished its work twice and both reports were refused, because
one `not_run_here` reason ran past 300 characters (about 500). A crew cannot repair its report
once it has exited, so the whole build was lost each time. Not tagged yet; the maintainers tag after
the merge.

### Changed

- A `not_run_here` reason longer than 300 characters is cut to 300 with "…" instead of refusing the
  report. Nothing matches against a reason. The command must still fit exactly, because the job
  gate matches it character for character.
- The README status line names the current version again (0.12.0 had left it at 0.11.1).

## [0.12.0] - 2026-11-05

Gates at the end of a phase found critical problems in pull requests that had been merged already. Now
every pull request gets the full gate before the merge, its depth set by size and risk and stated in the
brief. Crews get only the skills the capability matrix names, the plugins they run with are pinned, and
new plugin versions and changed sources become board items instead of arriving unnoticed. Not tagged yet;
the maintainers tag after the merge.

### Added

- The gate per pull request: the review brief names each mandatory analyzer with one line on why, and each
  gate analyzer it leaves out with why. Diff review and spec check always; security as before and for any
  changed file under a glob of `merge.contract_paths`; the similar-bug scan after a fix round, and in the
  first round whenever diff review reports `findings`; performance in the large tier. The mutation probe must
  run in the large tier, for an item of type `fix` and in a fix round. A small docs-only pull request gets no
  security analyzer.
- `collect` refuses an approval while an owed analyzer has no result or reads `skipped:`, and names all of
  them in one line (`approval refused: no result for …; mandatory analyzer skipped: …`). The launch record
  holds `onFinding` and `probeRequired` for that.
- Crew settings deny every installed skill the brief does not name (`permissions.deny` with `Skill(<name>)`,
  from the user skills and the plugin cache of the crew's config dir), and the denied list. Claude Code has
  no skill allowlist that holds under `bypassPermissions`, so the list is built from what is installed.
- A missing offered skill no longer goes unnoticed: the brief names it under "Offered but not installed" and
  `collect` prints `skillsMissing`. A missing required skill still refuses the launch.
- `plugins:` in `studio.yaml`: each plugin crews need at one exact version (`name@marketplace`, `version`,
  optional `marketplace` URL), over the defaults `superpowers@superpowers-marketplace` 7.0.2 and
  `studio@studio-marketplace` at Studio's own version. `studio account setup-plugins` installs them, reads the
  installed versions, updates once and fails naming both versions when one still differs (`claude plugin
  install` takes no version). A launch refuses while a pinned plugin is installed at another version
  (`installed_plugins.json` of the config dir). `studio doctor` shows pinned and installed.
- `studio skills check [--now] [--security <name>]...`: pins against what the marketplaces offer, sources
  against upstream (`sources check`). Each update is one `chore` item for a builder (`Update <name> to
  <version>`, `Review upstream change in <source>`) whose Definition of Done compares the change, runs the
  scenarios in `test/skills/`, proposes the adaptation of Studio's rules and adopts only after a green review.
  Idempotent by the note `skills-update: …`. Advisories (`security`, `CVE-`, `GHSA-`, `security: true`) and
  `--security <name>` give priority 0. `tick` runs it at most once in 30 days per project and prints
  `skillsCheck`.
- `watch:` for vendored sources in `SOURCES.yaml`: the upstream files vendored content adapts (the `ehmo`
  platform files) are fetched, pinned and judged by `setup sources` and `sources check`; none reaches a crew.

### Security

- studio.yaml can only pin versions: a project config that changes the marketplace of a default plugin is
  refused, and an extra plugin is installed only when `allowed_plugins` in the owner config names it with its
  marketplace. A change of `.studio/studio.yaml` in a pull request always gets the security analyzer.
- The skill deny list fails closed: skills are named by their `SKILL.md` front matter (the directory name is
  denied too), plugin skills are found at the install paths of `installed_plugins.json` as well as in the
  cache, and an installed skill whose name no `Skill(...)` rule can hold refuses the launch.
- Versions from marketplaces and the CLI are checked against the pin pattern before they reach a title, note,
  Definition of Done or output; others are dropped and named under `problems`. Table output replaces control
  characters.

### Changed

- Upgrading: run `studio account setup-plugins` once after updating. A launch now refuses while the crew
  config dir holds `studio` or `superpowers` at a version other than the pin (an older `studio` after this
  update, say); `setup-plugins` works on a crew dir set up before (an "already added" or "already installed"
  answer counts as done). A pin newer than what the marketplace offers blocks launches until the marketplace
  offers that version or the pin is lowered. Extra plugins pinned in studio.yaml need an `allowed_plugins`
  entry in the owner config, or they are no longer installed.
- A source of unknown licence is not used: `better-auth` is neither fetched nor checked (`notUsed`), and its
  row reads `skipped: licence unknown`, also when a copy sits fetched below the owner root.
- The similar-bug scan is listed for every review; its analyzer file takes diff review's findings in a first
  round.
- The lead skill: a "Skills and sources" section (update items, advisories, pins, `skillsMissing`, refused
  approvals) in place of "Sources"; `sources check` with `unclear` goes to its update item without an owner
  line, a licence `conflict` still gets one.

## [0.11.1] - 2026-11-05

The board pane showed the crew, the queue and the CI figures, but not what needed the owner, what
waited for what, or how far each epic was. It now opens on a work list that starts with the
decisions, and a pipeline view is one command away. Not tagged yet; the maintainers tag after the
merge.

### Added

- Work list as the pane's default view: header with the project and the age of the state, one line
  of counts (`! decisions needed`, `● running`, `◷ waiting`, `✓ today`), a highlighted "Decision
  needed" block with a next step to say, each epic with a progress bar and merged of total and its
  items sorted decision, running, waiting, ready (a waiting item with its reason on a dimmed second
  line, done items folded), "Without epic", and one footer line (CI, median lead time,
  `/studio more`). Empty sections are left out.
- Pipeline view (`/studio pipeline`): READY, BUILDING n/wip, REVIEW n/wip, QUEUE and TODAY columns
  with cards (sign and id, short title, epic code, time in stage, what it waits for), `⚠ full` on a
  full column and a row of its own for blocked work. Narrower than five columns, the pane draws the
  work list instead.
- `/studio list`, `/studio pipeline` and `/studio more` (the earlier detailed sections) switch the
  view; the choice is kept in the plugin's store. `/studio lang de|en|auto` sets the language.
- States for both views: no work yet (with an example of what to say), paused since HH:MM with
  `→ /studio resume`, and a state older than 10 minutes with a hint to start the lead loop.
- English and German text in the pane, the status line and the toasts. German follows
  `/studio lang`, else Claude Code's `language` setting, else the locale (`LC_ALL`, `LC_MESSAGES`,
  `LANG`); commands stay English in both.
- `state.json` carries what the pane needs: `items` (every item that is not merged or dropped,
  reviews aside, with `stage`, epic, components, the time it entered the stage and a `wait` reason
  with a code), `needsLead` (the latest tick's lead list with a code, a short reason and a next step
  to say), `wip`, `project`, `pause` (with the time on the owner's clock), and the item and epic of
  each merge of today.
- `studio tick` keeps its lead list and holds in `tick.json` in the state root (a protected state
  file for crews), only from a complete tick: one that did not run, lost its lock or had a phase
  fail keeps the last good record. An item that moved after that tick drops out of the list.
- The crew report template states the limit of each one-line field in plain words (`<error line,
  one line, at most 300 characters>`, and the same for the commands, workflows, jobs and skip
  reasons), and that one field over its limit rejects the whole report.

### Changed

- Every state in the pane has a sign and a word; a title is cut with "…" by terminal cells (wide
  characters and emoji count two), never the id, the sign or the stage; the pipeline draws the work
  list when an id does not fit its column. Long lines in the work list wrap instead of being cut.
- Crew text never reaches the "Decision needed" block: each lead decision shows a fixed phrase for
  its kind (`crew has a question`, `needs a decision`, ...), the full line only under "For the
  lead" in `/studio more`. A hint line starts with `→` two cells in and nothing else does.
- The pause time and "today" use one zone: the owner's `crew_label_limits.timezone`, else the system
  zone (the pause time was told in UTC before).
- A `state.json` without `items`, written by an earlier Studio, draws the detailed view as before.

## [0.11.0] - 2026-11-05

Larger work lived as phases in a hand-edited `ROADMAP.md`. Sessions wrote claims into the file, numbered
phases by hand (sometimes the same number twice), and opened pull requests only to take a phase. Now the
board holds epics, Studio numbers them, and `ROADMAP.md` is rendered from the board. Not tagged yet; the
maintainers tag after the merge.

### Added

- Epics on the board: a top-level `epics:` list next to `items:` with `id` (`E-<n>`), `title`, `goal`,
  `acceptance` (at least one line), optional `components`, `status` (`open`, `accepting`, `done`,
  `dropped`), `history`, and `imported_from` after an import. Items take an optional `epic: E-<n>`, which must
  name an epic on the board; only a merged or dropped item may keep a dropped epic. A board without
  `epics:` loads and saves byte-identical.
- The status rule: an open epic whose items are all merged (at least one, dropped ones aside) moves to
  `accepting` on every item move (collect, merge queue, drop), and back to `open` when new work joins it.
  `studio tick` applies the rule to a board edited by hand too and lists accepting epics under the new key
  `epicsReady`, which is left out while none is accepting. No command sets `done` yet; the acceptance comes in a later version.
- `studio epic add "<title>" --goal "<text>" --acceptance "<line>"... [--component <id>]...` (refused under
  `STUDIO_ROLE=crew`, under the board lock, prints the new id), `studio epic list` (items by status and
  merged of total), `studio epic show <id>`, `studio epic edit <id> [--title] [--goal] [--acceptance]...` (refused under
  `STUDIO_ROLE=crew`, under the board lock), `studio epic drop <id>` (refused while the epic has open items).
- `studio add --epic <id>` attaches the new item (an open or accepting epic only); `studio board --epic <id>`
  lists one epic's items, and `studio board` gets an epic column when the board has epics.
- `studio roadmap [--write] [--out <file>] [--force]`: renders a deterministic markdown roadmap from the
  board (a header saying it is generated, one line per epic with `[ ]`, `[~]` or `[x]` and merged of total,
  its goal and acceptance, then the open items in no epic). `--write` writes `ROADMAP.md` inside the project
  through a temporary file and a rename, and refuses a file without the generated header unless `--force`;
  it is refused under `STUDIO_ROLE=crew`. The target is checked by its real path (no linked folder leading
  out, no link as the target), never below `.studio/` or `.git/`, and `--force` takes only a `.md` file.
- `studio roadmap import <file> [--write]`: one epic per `- [ ] Phase <n> — <title>` line (also `[~]`, `[x]`,
  `–`, `-` or `:` after the number, bold markers, trailing `@claim:` tags) not imported yet, recorded as
  `imported_from: "<file>#Phase <n>"`, so a second import adds nothing. A `[~]` phase stays open with the
  note `in progress at import (claim: <session>)` and renders as `[~]` until it has items. The file must be
  a regular file inside the project, at most 1 MB and 500 phases; a line over 2000 characters, a phase number
  that is none, or a phase that would make an invalid epic is listed under `skipped` and the rest goes on. A dry run without `--write`; no
  items are created.
- The Studio board pane lists open and accepting epics with merged of total above the crew working on their
  items; `state.json` carries `epics` and each crew's `epic`. Without epics the pane is unchanged.

### Changed

- The lead skill turns a larger request into an epic with its pieces as items, and renders `ROADMAP.md`
  with `studio roadmap --write` instead of editing it; it replaces a hand-written file only after showing
  the diff, with nothing skipped and the owner's yes; `/studio:add` offers a fitting open epic.

## [0.10.0] - 2026-11-04

A new owner needed two `/plugin` commands, then three separate hidden-input commands in a terminal
(`studio secret set crew-token`, `claude setup-token`, `studio account add <label>`), and a `studio`
command in that terminal that the plugin did not provide. Now: install the plugin, run `studio setup`
once in a terminal, then `/studio:init` in Claude Code. Not tagged yet; the maintainers tag after the
merge.

### Added

- `studio setup [--link]`: the owner's one-time setup, in a terminal only (refused without one and
  under `STUDIO_ROLE=crew`). Numbered steps, each skipped when done: `gh` installed and logged in
  (else the fix and a stop); the crew token, explained with the permissions it needs, through the
  existing `secret set crew-token` (checked against `primary_repo`, else `origin`'s GitHub
  repository, else one it asks for); a Claude account for crews through the existing `account add`,
  after asking to run `claude setup-token` in another tab, label `main` unless another is typed;
  `studio` in the terminal. It ends with "run /studio:init". No token is echoed.
- `--link`: after a yes, writes `~/.local/bin/studio` when `~/.local/bin` is on `PATH`: a shim
  (a regular file with the marker line `# studio-shim v1`, written through a temporary file and a
  rename) plus the launcher's path in the owner config dir. The shim uses that path while its
  plugin folder has no `.orphaned_at`, else finds the enabled `studio@…` plugin with
  `claude plugin list --json` (`readFromFolder`, else `installPath`) and rewrites the cache, so it
  survives plugin updates. Without `claude` on `PATH` it says so. It never edits shell files and
  replaces only a file with exactly that marker.
- The label prompt of the account step comes first and is visible; a label that starts with
  `sk-ant` or is longer than 32 characters is refused before the hidden token prompt, and so is a
  token typed at the visible repository prompt.
- `/studio:init` (skill `studio:init`, only on request): runs `studio init`, explains the checks and
  the proposal in plain words, writes with `--write` only after a yes, commits the two files only
  after an explicit yes (on the default branch it suggests a branch first), never pushes, and adds a
  first item from the owner's own words.
- `/studio:add` (skill `studio:add`): turns work described in plain words into an item, shows title,
  type, component, paths and DoD and waits for a yes, then runs `studio add` with every value in
  single quotes (`--name='value'`, the title after `--`), and tells the owner the id and what
  `missing` says.

### Changed

- `init`: a missing crew token or Claude account is one next step, "run studio setup once", with the
  `node <plugin>/bin/studio setup --link` line for a terminal without `studio`; the first item can be
  added with `/studio:add`.
- `setup` without a subcommand is the guided setup; before, it was a usage error.
- README: the quick start follows the new path.

## [0.9.1] - 2026-11-04

### Changed

- The lead skill turns a request the owner makes in plain words into `studio add`, shows the item and
  ticks. Before, it had no step for this, and the only documented way to add work was editing
  `board.yaml` by hand. Not tagged yet; the maintainers tag after the merge.

## [0.9.0] - 2026-11-04

Setting up a project meant writing `.studio/studio.yaml` and `board.yaml` by hand, running
`setup ci` and `setup stack`, storing a crew token, installing the plugin and knowing the lead
loop. An owner who has never seen Studio now runs one guided command in his project and gets a
plain list of what is missing and what to do next. Not tagged yet; the maintainers tag after the
merge.

### Added

- `studio init [--write]`: checks the prerequisites (git 2.38 or newer, `gh` installed and logged
  in, the `claude` CLI, Node.js 24 or newer, a platform with Claude Code's sandbox, `origin` on
  GitHub) with a fix for each failure, and warns, with the command to run, when the crew token, a
  stored Claude account or the `superpowers` plugin is missing, or when `.gitignore` ignores
  `.studio/`. It proposes `.studio/studio.yaml`: `primary_repo` and `repos` from `origin`, the
  `ci:` block of `setup ci` (GitHub-hosted with a warning when there is no usable proposal), the
  stacks of `setup stack`, a builder and a reviewer, `sandbox.network_allow` for GitHub and the
  package registries of the manifests found, and one component per manifest folder below `apps`,
  `packages`, `services`, `crates` and `libs` plus `tooling` (none for a single-package
  repository). Without `--write` nothing is written and the exit code is 0; with `--write` it
  writes `studio.yaml` and an empty, commented `board.yaml` only when no check failed (else exit
  1), after loading both with Studio's own loaders, and never overwrites either file. It ends with
  the next steps. `--json` prints the same data.
- `init` details: each `gh` call has 15 s and `claude --version` 10 s; the login check asks
  about github.com only. Runners that cannot be read are a `ci` warning, the first next step and a
  comment in `studio.yaml`. Both files are parsed in memory by the real loaders, so a dry run
  writes no file anywhere. `--write` refuses a `.studio` that is a link or a file and removes what
  it wrote when a later write fails. `network_allow` also gets Docker Hub for a `docker` stack.
  Next steps leave out what the checks found done.
- `studio add "<title>"`: appends a ready builder item with the next free id, `--type` (default
  `fix`; a `feature` needs `--plan`), `--repo`, `--path` (relative, no `..`), `--dod`,
  `--component` and `--plan`, checked against the board schema and the config, under the board
  lock. It names what the planner still needs (`missing`), warns when an item has no path, and
  notes a CI item.
- `init` and `add` refuse under `STUDIO_ROLE=crew`.
- README: a quick start at the top (install, `init`, `init --write`, next steps, `add`, the lead).
  The former quick start is now "Writing the files by hand".

### Changed

- `setup ci` and `doctor` keep their output; their detection and checks are functions that `init`
  calls too. Runner and visibility reads take an optional timeout, and `claude` plugin runs an
  optional timeout of their own.
- `setup stack` also reads one level of `libs`, the same folders `init` proposes components from.

## [0.8.0] - 2026-11-04

From a real run: on every pull request the lead did two things by hand that a person using Studio
would not know to do. After `collect` opened a builder's pull request, it added the review item to
the board itself. Then it polled in shell loops of its own: `collect` again while the pull request
was held for CI capacity, `launch` of the review again while it waited for checks ("ci pending"),
`collect` of the review again while "the approval counts only with green checks", then `queue add`
and `queue run`. Each step has a fixed trigger that Studio already checks. Not tagged yet; the
maintainers tag after the merge.

### Added

- `collect` adds the review item when it opens or reuses a builder's pull request and the item
  moves to `in_review`, unless a review naming that pull request is still open (neither merged nor
  dropped): the next free id with the builder's prefix, title `Review of <id> (PR #<n>)`,
  `role: reviewer`, `type: review`, `status: ready`, the builder's repo, paths, DoD and named
  components, and the note `review <repo>#<n>`. The output names it (`review: <id>`). After a fix
  round the next collect adds a new one.
- `studio tick`: one lead heartbeat, idempotent, for the lead only (refused under
  `STUDIO_ROLE=crew`). It collects every item whose crew has ended and every pull request held for
  CI capacity, adds a review item for a builder in review that has neither an open review nor a
  verdict, launches what the plan assigns under every gate of `launch` (a review whose pull
  request it opened in the same tick waits for the next one), queues each builder whose approval
  is stored (not again after a merge that failed after that approval), and runs the queue in the
  same process when it holds pull requests, an entry a killed run left current, or a queued item
  the queue no longer holds, and no run is active. It prints one JSON object with `collected`,
  `reviews`, `launched`, `queued`, `merged`, `held`, `needsLead` and `errors`, always, also when a
  whole phase fails; one item's or phase's failure is recorded and the others go on. A pull request
  held because the CI read failed is also an error. A second tick while one runs does nothing; a
  tick that lost its lock stops before the next phase.
- Refusals that only mean "not now" (launch lock busy, item not in the current plan, account
  blocks being reconciled, queue already running, a queue hold) are a typed `HeldError`; their
  messages are unchanged.

### Changed

- `collect`, `launch`, `queue add` and `queue run` are functions `tick` calls; their output and
  exit codes are as before.
- The lead skill runs `studio tick` in a second heartbeat loop and acts on `needsLead`; the manual
  review item and the polling are gone. The hard rules stay: one fresh reviewer per pull request,
  the fix limit, never a report written by the lead.

## [0.7.3] - 2026-11-04

`stop --requeue` from 0.7.2 moved an item straight from `assigned` to `ready`, and it could do
that any number of times. The lead routine allows one relaunch after a missing report, through
`blocked`, and a second miss stays `blocked`. The command now follows that rule, and the lead skill
names it. Not tagged yet; the maintainers tag after the merge.

### Changed

- `stop --requeue` moves the item to `blocked` and then to `ready` (one relaunch). If the item was
  requeued before, it stays `blocked`.
- The lead skill's collect step now uses `studio stop <id> --requeue` instead of a manual move.

## [0.7.2] - 2026-11-04

From a real run: a crew ended without a usable report. Its item stayed `assigned`, `collect`
could not move it, and `launch` takes only `ready` items, so the lead had to drop the item and
add a copy. Not tagged yet; the maintainers tag after the merge.

### Added

- `studio stop <id> --requeue` stops the crew, or closes its record if it has ended, and puts an
  `assigned` or `in_progress` item back to `ready` with a note. `launch` then takes it again.

## [0.7.1] - 2026-11-04

From a real run: a builder crew stopped at once, reporting "Operation not permitted" when it
tried to read its own brief. The guard allows a crew to read its brief, caps and rules, but the
sandbox's `allowRead` list let back only the clone, the crew's tmp dir, its HOME and the
toolchain. The whole state base is denied, so a sandboxed read of the brief failed. Not tagged
yet; the maintainers tag after the merge.

### Fixed

- `allowRead` also holds the crew's own `briefs/<id>.md`, `briefs/<id>.caps` and
  `briefs/<id>.rules`. Nothing else of the state root comes back.

## [0.7.0] - 2026-11-04

Components: a product often has several parts that are developed and released on their own (an
API server, a desktop app, an agent, a web app in a second repository). Until now a project had
`repos:` and items had `repo` and `paths`, but the owner could not see or steer work per part, and
nothing kept one part from taking all crews. Not tagged yet; the maintainers tag after the merge.

### Added

- `components:` in `studio.yaml`: `id`, `name`, `repo` (one of `repos`), `paths` (globs) and an
  optional `wip`. Without it everything behaves as before.
- Board items may name `component` or `components` (cross-cutting work); an id the config does not
  know refuses the board, except on merged and dropped items. An item that names none belongs to
  every component of its repo whose globs match or overlap one of its `paths` or `touches`, by the
  same prefix rule as the planner's touch overlap (a bare directory stands for everything below it).
  An item with neither belongs to no component unless it names one.
- The planner holds a component at its `wip` (items in `assigned` or `in_progress`), on top of role
  WIP; a cross-cutting item counts against each of its components, and a held item gets the reason
  `component <id> wip full`.
- `studio board --component <id>`; `board` and `status` show a component column and `plan` names
  the components of each assigned item, all only when components are configured.
- `state.json` carries the components and those of each crew; the pane groups the crew under a
  heading per component, with "cross-cutting" and "no component" last.
- `studio overview`: every project state root of this owner with items per status, running crews
  and queued merges. It reads only (no reconcile, no migration of the owner state), reports a state
  root it cannot read in full and goes on, skips a root whose marker names another root's project,
  reads no linked `board.yaml`, strips control characters, and needs the owner in a terminal.

## [0.6.12] - 2026-11-04

From the same real run: the fourth review approved the pull request, and `queue add` still
refused it, because two earlier reviews of the same pull request had ended blocked and so still
counted as open. The lead had to drop them by hand. Not tagged yet; the maintainers tag after the
merge.

### Changed

- When `collect` stores an approval, it drops every earlier review of the same pull request that
  has no running crew (blocked, ready or planned), with the note "superseded by <id>". A review
  whose crew still runs stays as it was. The fix-round count is unchanged, because dropped reviews
  still count.

## [0.6.11] - 2026-11-04

From the first merge-queue run on a real pull request. The queue brought the approved pull request
up to date and waited for its checks. One check failed under runner load, so the queue stopped
without merging, as intended. After that test was fixed on main, a second run updated the branch
again, and the queue then refused: "the approval is for <the reviewed head>: review it again". Only
one branch update counted as covered by an approval, so every red run after an update needed a new
review, even though nothing but the base had changed. Not tagged yet; the maintainers tag after
the merge.

### Changed

- An approval covers up to five branch updates in a row on top of the reviewed head. Each one is
  checked as before: GitHub signed it, its first parent is the commit before it, its other parent is
  on the approved base, and its tree is exactly the clean merge of the two. One link that fails
  refuses the whole chain, so the chain holds no change that was not reviewed, apart from the base.

## [0.6.10] - 2026-11-04

From the same real review run, after 0.6.9: the gate refused the approval with "no CI job named
for it". The list Studio wrote for the reviewer (`pull-request/not-run-here.txt`) put each
command and its reason on one line, `<command> (missing <service>: <reason>)`, and the brief said
to copy the command "as listed". The reviewer copied the whole line, so no entry matched. Not
tagged yet; the maintainers tag after the merge.

### Changed

- `not-run-here.txt` lists each distinct command once, on its own `command:` line. The missing
  services and reasons are indented below it, and a command the builder listed several times
  appears once.
- The brief asks for the command exactly as on its `command:` line, with nothing appended,
  because the gate matches it character for character.

## [0.6.9] - 2026-11-04

From the first real run of the 0.6.8 gate: the reviewer approved, and `collect` refused the report
because two `covers` lines were longer than 300 characters. The reviewer also warned that the
gate would refuse every job in the repository, because each calling job in `ci.yml` has an
`if:` on a changes job. Not tagged yet; the maintainers tag after the merge.

### Changed

- The job gate allows `if:` on the named job and on its calling jobs. A job that an `if:` skips
  reports a skipped check, and a skipped check never counts as passed, at collect or in the merge
  queue. `continue-on-error` is still refused.
- `covers` may be up to 600 characters (it was 300, like every crew line). The review brief and the
  report template now name the limit.

## [0.6.8] - 2026-11-04

From the first real run of the 0.6.6 job gate: a reviewer named the right jobs for a monorepo's
`not_run_here` commands, and `collect` refused them, because those jobs live in reusable workflows
that `ci.yml` calls, and because the commands run through task runners (`cargo nextest`,
`pnpm turbo`), so no `run:` step names them. The gate could never pass in such repositories. Not
tagged yet; the maintainers tag after the merge.

### Changed

- Reusable workflows: a named workflow file that is only `workflow_call` counts when, at the base
  and at the head, a `pull_request` workflow calls it from a job with
  `uses: ./.github/workflows/<file>`. Its checks are then `<caller job> / <job>` in the caller's
  workflow, with an optional ` (<leg>)` for a matrix leg; every instance of every calling job must
  pass and at least one must exist. The calling job may not have `if:` or `continue-on-error`,
  and the caller workflow's name must be unique. One level only: a job that calls a further
  reusable workflow, a file called only through another reusable workflow, and a remote
  `uses: <owner>/<repo>/...@<ref>` are refused with their own reason.
- The run-step test is gone: it could not work with task runners and gave false assurance. Each
  `not_run_here_jobs` entry now needs `covers`, one plain line from the reviewer on why the job
  covers the command (format characters stripped, at most 300 characters); an entry without it
  refuses the approval. `collect` prints each approved job with its `covers` text for the lead
  (`notRunHereJobs`). The hard gate: the job holds at the base and at the head under the same check
  names, its definition (with its calling jobs) is unchanged between them unless the item is a CI
  item, and all its checks on the pull request head passed. A launch records whether the item is a
  CI item (`ciItem` in the launch record), and `collect` reads it from there.
- A refusal's board note names the entry and the rule in fixed text, as before; the reasons now
  name the new rules (`no covers text`, `the job definition changed`, `callers differ`,
  `one level only`, `remote reusable workflow`).
- The review routine and the report template ask for the file that defines the job, its name and
  `covers`, and say that a task runner may run the command.

### Security

- Check matching fails closed (found by an automated security review of this release's draft): a
  check is the job when its name is `<job>` or `<job> (<leg>)`, the leg being everything inside
  the outer parentheses, so a leg may hold a slash. A check of the same workflow whose name starts
  with `<job>` and a space but does not parse that way (`<job> (1) / x`, `<job> / x`, `<job> (1`)
  refuses the approval and the merge re-check; the draft dropped such checks, so a failing one
  could fall out of "every instance passed". Names that continue without a space (`<job>-slow`)
  are other jobs.

## [0.6.7] - 2026-11-03

From a real run: a reviewer launched while the pull request's CI was still running found nothing
wrong with the code but asked for changes only because CI was pending, which forced a needless fix
round. Not tagged yet; the maintainers tag after the merge.

### Changed

- The planner defers a review item with the reason `ci pending` while any check of its pull
  request head still runs or the checks cannot be read, and a review launch refuses then too. Red
  or skipped checks do not hold a review; a repository that reports no checks does not wait.
- The review routine says: if the code is fine and the checks are green, the verdict is `approve`;
  `changes_requested` only for a change the code needs, and never because checks still run (Studio
  holds an approval until they pass).

## [0.6.6] - 2026-11-03

From an independent review and an automated security review of 0.6.5 and of this release's first
draft: a `not_run_here` command could end up run nowhere while every gate passed, and the guard's
reading of `gh` and `git` options differed from theirs. Not tagged yet; the maintainers tag after
the merge.

### Changed

- The reviewer reads CI workflows at the base (`git show origin/<base>:.github/workflows/<file>`),
  never in the pull request head, which the crew may have edited. A change under `.github/`
  (workflows, actions) is a finding that blocks the approval. A CI item, one that declares paths
  below `.github/` in its `paths` or `touches`, may change what those globs name and nothing else
  there; a symbolic link at `.github` or below always counts. Launch reads the
  change in the owner's checkout with `git diff --name-only --no-renames <base>...<head>` (both
  sides of a rename count, any case, and a symbolic link at `.github` or below counts too), not
  from gh's file list, which can be cut short. A change it cannot read counts as one. `collect`
  refuses the approval then.
- A review report names, for each `not_run_here` command, the workflow file at the base and the
  job that runs it (`not_run_here_jobs: [{ command, workflow, job }]`). `collect` checks each in
  the owner's checkout at the pull request's base commit (`baseRefOid`, the base its checks ran
  against) and at its head: the workflow must run on `pull_request`, and its `name:` must be unique
  among the workflow files there, because `gh pr checks` names a workflow, not its file; the job must be
  in that file (by its `name:`, else its id) with no `if:`, no `continue-on-error` and no `uses:`
  (reusable workflows are refused); a `run:` step without `if:` or `continue-on-error` must start
  a line with the whole command (a heuristic). When the pull request changes that workflow file,
  the version at its head must pass the same test under the same name. Every check of that job in
  that workflow (`gh pr checks --json name,bucket,workflow`; matrix legs `<job> (<leg>)` count as
  instances, commit statuses do not count) must have passed: a skipped check that is not required
  counted as green before. A refusal blocks the review item with a note for the lead
  and stores no approval. An approval stores the jobs (`approved_jobs`), and the merge queue checks
  them again right before it merges.
- `collect` prints only the count and the missing services of `not_run_here`, no crew text.
- When `collect` reuses an open pull request of the branch, it renews its text with
  `gh pr edit --body-file`, so the `not_run_here` list there is never stale. Opening and editing
  both wait for CI capacity.
- The pull request text Studio writes starts with Studio's attribution and its `not_run_here`
  section; the crew's text follows below a line. Title and text lose control and format characters
  (bidi overrides, zero-width).
- `not_run_here` fields lose format characters; a field that is only such characters refuses the
  report, and the board refuses them. An empty YAML value (`not_run_here:`, `lessons:`,
  `questions:`, `not_run_here_jobs:`) reads as an empty list.
- The crew skill and brief name the one `gh pr create` form the guard allows (below).

### Security

- The guard no longer models gh's or git's option grammar; it allows listed forms only.
  - gh: `gh pr view`, `checks`, `diff`, `list` and `status`, each with its own exact list of
    flags (`--json`, `--jq`, and for some `--watch`, `--required`, `--name-only`, `--state`,
    `--limit`; every flag its own word, no `=`, no clusters, no `--web`), and exactly `gh pr create --head
    studio/<id> --base <item base> --title <text> --body-file <file>` from the clone root, each
    option once in any order, the file a plain relative path whose real path is in the clone. With
    `crew_allowed_workflows` set, also exactly `gh workflow run <listed workflow> --ref <listed
    ref>`. Everything else is refused: other subcommands and aliases, `gh api`, short or grouped
    options, `=`, `--template`, `--recover`, `--attach`, `-R`/`--repo`/`--hostname` anywhere.
  - git global options are an allowlist: `-C <dir in the clone>`, `-c <allowed key>`,
    `--git-dir=`/`--work-tree=` in the clone, `--no-pager`, `-P`, `--no-replace-objects`.
  - `git fetch` and `git pull` take listed options only (quiet, verbose, prune, tags, depth; for
    pull also rebase, fast-forward, autostash and `-X`/`--strategy-option` with a plain value),
    only `origin` as remote and plain refspecs. `git ls-remote` is `git ls-remote origin
    [<ref>...]`; `git push` goes to `origin` only. These and `gh pr create` run from the clone root,
    without `-C`, `--git-dir` or `--work-tree`.
  - `git clone`, `init`, `fetch-pack`, `upload-pack`, `upload-archive` and `archive --remote`,
    `--exec` or `--output` are refused. `git remote` is read-only (`-v`, `get-url origin`,
    `show [-n] origin`), `git submodule` only `status`. No write reaches a `.git` at any depth.
- The guard context names the crew's item and its base (`main`, where crews branch from), for the
  `--head` and `--base` checks; the brief names the same base.

## [0.6.5] - 2026-11-03

From a real crew run: a correct, one-crate fix ended `blocked` because the workspace's full test
command needed a database the sandbox does not have. Not tagged yet; the maintainers tag after the
merge.

### Added

- Reports take `not_run_here`: commands a missing service kept from running in the sandbox, each
  with `command`, `missing` (`database`, `docker`, `network` or `service`) and `reason`. The
  report stays `done`. An entry without one of those services, without a reason, or with control
  characters refuses the report; a `failed` report still blocks the item.
- `collect` carries the list on: into the pull request it opens (a section saying CI must run
  those commands), onto the board item (`not_run_here`, replaced by each done report) and into its
  output. A review launch writes it to `briefs/<id>.caps/pull-request/not-run-here.txt` and the
  routine tells the reviewer to check that a CI workflow runs them. An approval still needs green
  checks at collect, so CI stays the gate.

### Changed

- Crew briefs and the `studio-crew` skill scope the local test duty: the touched package, crate or
  workspace member, the Definition of Done's tests, lint and format, plus the full test command
  where it can run. A test that ran and failed is `failed`, never `not_run_here`.
- Crews push without `-u` (`git push origin HEAD:refs/heads/studio/<id>`), since the sandbox
  cannot write upstream tracking into `.git/config` and git printed an error after a good push.
  The brief names `git ls-remote` as the check; a crew that opens its own pull request passes
  `--head studio/<id>`.

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
