# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

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
