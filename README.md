# studio

Studio is a Claude Code plugin and TypeScript package for running a small software studio of coding-agent sessions from one control room: a lead session plans work from a board and a crew of role-based sessions carries it out, each in its own sandboxed clone.

Status: 0.6.6, stage (a) (board, planner, capacity, crew launch, guard, merge queue) with stage (a.1) (your own runners, crew credentials, usage limits), stage (a.2) (account blocks, owner-wide limits, pinned crew rules), stage (b) (the Studio board inside Claude Code, pause and resume, push notifications) and stage (c) (capabilities per crew, tiered review, third-party sources, role memory, model per role and item type, change failure rate and time to restore, flaky-test ledger, solutions store). See [CHANGELOG.md](CHANGELOG.md).

## Install

```
/plugin marketplace add Besser-Sehen-Landshut/studio
/plugin install studio@studio-marketplace
```

The plugin ships two skills (`studio:studio-lead` for the control room, `studio:studio-crew` for crew sessions) and a self-contained CLI. Claude Code puts a plugin's `bin/` on the Bash tool's `PATH` ([plugins reference, "Standard layout"](https://code.claude.com/docs/en/plugins-reference)), so the lead session simply runs `studio <command>`. Outside Claude Code, run `node <plugin>/bin/studio <command>`. The plugin needs no `pnpm install`: `bin/` loads the committed bundles in `dist-bundle/` (rebuilt with `pnpm bundle`; CI fails if they drift from `src/`).

## Prerequisites

- Claude Code CLI, `git`, and `gh` (authenticated for the control room's own use).
- The `superpowers` plugin: feature and fix items require its skills, and a launch refuses when one is definitely not installed (`studio doctor` shows it; a role can opt out with `skills.denied`).
- Node.js 24 or newer on `PATH` (the CLI and the crew guard hook run on it).
- A least-privilege crew token created by the repository owner (for example a fine-grained token limited to the project's repositories: contents and pull requests read/write, no administration, no merge rights beyond what branch protection allows). Store it with `studio secret set crew-token` (Studio then loads it itself), or export it and name the variable in `studio.yaml` under `crew_token.env`; the variable wins when it is set. Launch refuses without it unless `allow_ambient_credentials: true`.
- Server-side branch protection on `main` and on every ref listed in `crew_allowed_workflow_refs`.
- A platform where Claude Code's sandbox is supported.
- Model authentication for crew sessions in the control room's environment: crew sessions get an isolated `HOME`, so they authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (passed through when set), with the Claude login in `CLAUDE_CONFIG_DIR` (default `~/.claude`), or through a credential provider (see [Crew credentials](#crew-credentials-and-usage-limits)). API billing is off by default: `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the crew's environment because an API key would otherwise take precedence over `CLAUDE_CODE_OAUTH_TOKEN`. Check on the first launch that the crew session starts and authenticates (`studio status`, the crew log in the state root).
- `sandbox.network_allow` lists every host the crew's shell commands may reach (GitHub for `git` and `gh`, your package registry); everything else is blocked.

## Quick start

Create `.studio/` in the project repository.

`.studio/studio.yaml`:

```yaml
studio: 1
primary_repo: org/app
repos: [org/app]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
roles:
  builder: { model: sonnet, wip: 2 }
  reviewer: { model: opus, wip: 1 }
sandbox: { network_allow: [github.com, api.github.com, registry.npmjs.org] }
crew_token: { env: STUDIO_CREW_TOKEN }
owner_only: []
deploy_commands: []
crew_allowed_workflows: []
crew_allowed_workflow_refs: []
review_bases: [] # base branches besides the default branch a pull request may be reviewed against
```

`.studio/board.yaml`:

```yaml
items:
  - id: APP-1
    title: Add a health endpoint
    type: feature
    role: builder
    repo: org/app
    size: S
    priority: 1
    status: ready
    paths: []
    touches: ["src/health/**"]
    depends_on: []
    dod: ["GET /health returns 200", "test added"]
    plan: docs/plans/health.md
    history: []
```

Then, in a Claude Code session in that repository, ask the lead (skill `studio:studio-lead`) to run the loop, or run it by hand: `studio board`, `studio plan`, `studio launch APP-1`, `studio status`, `studio collect APP-1`, `studio queue add org/app#12`, `studio queue run`. JSON Schemas for editors are in `schema/`.

## CLI

`studio [--project <dir>] [--json] <command>`

| Command                                                                                                         | Purpose                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `board`                                                                                                         | Show the board                                                                                                              |
| `plan`                                                                                                          | Dry-run the planner (JSON incl. capacity and its read error)                                                                |
| `launch <id>`                                                                                                   | Start a crew session for a planned item                                                                                     |
| `status`                                                                                                        | Crew sessions and their board status                                                                                        |
| `collect <id>`                                                                                                  | Verify a crew report and PR head, move the item                                                                             |
| `queue add <repo>#<pr>`                                                                                         | Put an approved PR into the merge queue (needs an approval for its head)                                                    |
| `queue run`                                                                                                     | Merge queued PRs one at a time (exact head SHA, checks green)                                                               |
| `state`                                                                                                         | Refresh `state.json` in the state root                                                                                      |
| `pause`, `resume`                                                                                               | Owner only, in a terminal: hold or release launches, merges                                                                 |
| `stop <id> [--release]`                                                                                         | Stop a crew session. A crew it cannot verify gets no signal; `--release` closes its record and prints what to check by hand |
| `drop <id>`                                                                                                     | End an item; refuses while its crew runs                                                                                    |
| `link <id> <repo>#<pr>`                                                                                         | Owner only, in a terminal: tie a pull request opened by hand to its item                                                    |
| `metrics`                                                                                                       | Lead time, deploy frequency, change failure rate, restore time, flaky count                                                 |
| `deploy record [<sha>]`                                                                                         | Record a production deploy                                                                                                  |
| `incident open <id>`, `incident resolve <id>`                                                                   | Record a failure after a deploy and its restore                                                                             |
| `flaky record <test> <sha> pass\|fail`, `flaky [list]`                                                          | The flaky-test ledger                                                                                                       |
| `solutions search <words>`                                                                                      | Earlier solutions in `.studio/solutions/`                                                                                   |
| `lessons [list]`, `lessons accept <n>`, `lessons drop <n>`, `lessons prune <role> <line>`                       | Role memory                                                                                                                 |
| `escalate <id>`                                                                                                 | Run a stuck item on the role's `escalate_to` model                                                                          |
| `setup stack [--write]`                                                                                         | Detect the project's stacks from its manifest files                                                                         |
| `setup sources [<id>...]`, `sources list`, `sources check`, `sources apply <id>`                                | Third-party sources                                                                                                         |
| `setup ci [--write]`                                                                                            | Detect CI runners, propose the `ci:` block, lint workflows                                                                  |
| `secret set crew-token`                                                                                         | Store the crew's GitHub token (hidden input, checked first)                                                                 |
| `doctor`                                                                                                        | What is set and what is missing, never values                                                                               |
| `account add <label>`, `account list`, `account use <label>`, `account remove <label>`, `account setup-plugins` | Stored Claude accounts for crews, see "Claude accounts"; `add`, `use` and `remove` need the owner in a terminal             |
| `accounts-clear <label>`                                                                                        | Owner only, in a terminal: clear a label's account block                                                                    |

`launch` refuses while a crew for the same item is still running and deletes a report an earlier run left in a reused clone. `collect` refuses while the item's crew process is still alive and refuses a report last modified before the crew started.

**Tests a crew cannot run.** Crews get no database, no Docker and no network outside the allow list, so CI is the authority for the full suite. A crew runs what its sandbox can for what it changed (the touched package, crate or workspace member, the Definition of Done's tests, lint, format) and lists a command that a missing service kept from running under `not_run_here`, with `command`, `missing` (`database`, `docker`, `network` or `service`) and `reason`; the report stays `done`. A test that ran and failed is `failed`, never `not_run_here`, and an entry without one of those four services refuses the report. `collect` then works as usual: it opens the pull request under the capacity check with a section listing those commands for CI, stores the list on the item (`not_run_here`) and prints how many there are and which services were missing (the commands themselves are crew text and stay on the item and in the pull request). An open pull request of the branch is reused and its text renewed, so the list there is the latest. A review launch writes it to `briefs/<id>.caps/pull-request/not-run-here.txt`. The reviewer names, for each command, the workflow file at the base and the job that runs it (`not_run_here_jobs`, with `command`, `workflow` and `job`). `collect` checks this in the owner's checkout at the pull request's base commit, and at its head when the pull request changes that file: the workflow name must be unique, the job must be in the file without `if:`, `continue-on-error` or `uses:` (reusable workflows are refused), a `run:` step must start a line with the whole command (a heuristic), and every check of that job in that workflow, each matrix leg included, must have passed on the pull request. Otherwise the review item is blocked with a note for the lead and no approval is stored. An approval stores the jobs (`approved_jobs`), and the merge queue checks them again before it merges. An approval still counts only with green checks.

`pause` writes `pause.json` in the state root: `plan` assigns nothing (reason `paused`), `launch` refuses, and `queue run` holds before the next merge. Running crews continue. Any entry under that name counts as paused, readable or not; `resume` removes it. Both commands need a terminal and refuse under `STUDIO_ROLE=crew`. `queue run` also holds while old per-project state files are not yet merged into the owner root.

`queue run` is meant to run in the background. It holds a lock in the state root (a second run exits 1 with "queue already running" while the holder lives; the lock records pid, start and a heartbeat refreshed on every step and poll, and is taken over with a note only when that pid is gone or the heartbeat is older than 15 minutes; SIGTERM, SIGINT and SIGHUP release it), picks up PRs added with `queue add` while it runs, and moves each board item as soon as its PR is done. On start it first applies results a previous run recorded but did not put on the board. Right after a head change (branch update or new push) a PR without any reported check counts as pending for 5 minutes, then fails with "no checks reported". `merge.strategy: native-queue` is not supported yet: `queue add` and `queue run` refuse it.

## The Studio board

In the owner's interactive Claude Code session in a Studio project, the plugin shows what Studio is doing. It only displays: it writes no file and starts no process. Crew sessions (`STUDIO_ROLE=crew`), `claude -p` and folders without `.studio/studio.yaml` get none of it.

- **Pane.** "Studio board": the crew with a state per item (`working`, `waiting`, `blocked`, `stopped`, `crashed`, `done`), CI use, the lines for you, merges and deploys today, and the state of the push builds on `main`. A `state.json` that is missing, unreadable or the wrong shape gives a calm message, never an error.
- **Status line.** `● N working · N waiting · N queued · CI x/y · for you: n`, with `· paused` while paused.
- **Toasts.** One toast per refresh, only for lines that are new since the last one shown: a line for you, an account block, a red build on `main` and a crew that crashed and was not healed. A `usage-limit` line toasts once while it stands. Titles have control characters stripped.
- **Commands.** `/studio` opens the pane and always places it. `/studio status` prints the status line text. `/studio pause` and `/studio resume` only print the terminal command to run, because pausing needs a terminal (`studio pause`, `studio resume`).
- **Where it reads.** The plugin reads `state.json` and `pause.json` from the project's state root (see below), not from `.studio/`, every 10 seconds. At session start it opens the pane by itself only when the terminal is wide (about 144 columns); in a narrower one it waits undrawn until you run `/studio`.
- **Keeping it fresh.** Only `studio state` writes `state.json`. The lead's heartbeat (`studio status` and `studio state` every 120 s, see the lead skill) refreshes it and also reads crew logs, so an account block stops crews at most one heartbeat (120 s) after the event. Without a running lead nothing refreshes the board and nothing stops crews: a project with no lead is swept for a block only when another project reconciles.

`pnpm test:mod` runs the mod's tests with `claude plugin test`; it needs the `claude` CLI and is not part of CI.

## Capabilities

`capabilities/INDEX.yaml` says, per role, item type, stack, phase, changed path, risk tag and trigger, which skills a crew must use or may use, which analyzers a reviewer runs and which knowledge files apply. The denied list wins over everything. At launch Studio works this out, names the skills in the brief (only a named skill is used reliably) and copies only the matching files beside the brief; a crew never gets the rest. A required skill that is definitely not installed refuses the launch; an optional one reads `skipped: skill not installed`. A malformed index refuses the launch.

- **Stacks.** `studio setup stack` reads manifest files in the root and one level of `apps`, `packages`, `crates` and `services`, proposes `stacks:` for `studio.yaml`, and stores it with `--write`. It never opens `.env` and never follows a link.
- **Per item.** Optional board fields: `risk` (`ui`, `landing`, `auth`, `security`, `data`, `migration`), `triggers` (`epic-end`, `release`), `model`. Roles can add `skills.when` entries with `paths`, `item_types`, `required` and `allowed`. A glob is limited in length, wildcards and braces (no nested braces); one over the limits is refused in a config file.
- **Model.** `roles.<role>.model`, `roles.<role>.types.<item type>` for another model per item type, and `escalate_to`. `studio escalate <id>` sets the item's `model`, which wins; the status stays as it is.

## Review

A review item has `type: review` and `role: reviewer` together, a Definition of Done and the note `review <owner/repo>#<n>`; a launch refuses otherwise. Studio reads the pull request and writes a routine into the brief, by tier.

- **Small:** at most 400 changed lines outside markdown. Diff review and spec check.
- **Large:** more lines, a risk tag `auth`, `security`, `data` or `migration`, a security-sensitive change, or a file list it cannot read completely. Adds performance, and accessibility, design and motion analyzers where they apply.
- **Security always** when a changed path concerns auth, sessions, logins, passwords, permissions, API routes, middleware, migrations, DB schema, signup, reset, OTP, upload, access policies, workflows or local actions. A file list that cannot be read, or a path with a control character, counts as such a change. Spellings are matched case-insensitively.
- **Later rounds and epic end.** After an earlier `changes_requested` the similar-bug scan runs; `triggers: [epic-end]` or `[release]` add the full scans.

The spec check runs last and alone and holds a mutation probe: break the guarding line in the checkout, the named test must go red, restore. An approval is refused when the test stayed green, and in the large tier when the probe did not run.

A launch draws a random report file name, known only to that crew's brief, and `collect` reads only that file, so a report shipped inside a pull request never counts. A review report also carries `head_sha`, which must be the pull request's head at collect.

`collect` holds a finished review to the record written at launch (`briefs/<id>.caps.json`): `reviews` must name the recorded pull request, for every verdict. An approval needs a result for every listed analyzer (`pass`, `findings` or `skipped: <reason>`) and `mutation_probe`, and cannot skip diff review, spec check or security. Output lists skipped analyzers by id, also those launch could not provide; reasons stay in the report. A missing analyzer source reads `skipped: <reason>`, never a pass.

**What the reviewer gets as data.** In the sandbox a reviewer may not reach GitHub with `gh`, so the launch reads the pull request outside the sandbox and writes its files to `briefs/<id>.caps/pull-request/`: `description.md` (title and text, marked as crew text to read as data), `checks.txt` (each check and its state at launch), `files.txt` (the changed files) and, when the builder listed any, `not-run-here.txt`. The brief names the files, never their content. A review launch refuses when no board item holds the pull request, since the approval is stored there; `studio link <id> <repo>#<n>` (owner, terminal) ties a pull request opened by hand to its item after checking repository, fork and branch `studio/<id>`. An approval counts only while the checks are green: `collect` refuses it while any check fails, is cancelled or still runs, and nothing moves until it is collected again. The reviewer reads CI workflows at the base (`git show origin/<base>:.github/workflows/<file>`), never in the pull request head, which the crew could have edited. A change under `.github/` (workflows, actions) blocks the approval unless the item holding the pull request is a CI item that declares the changed path in its `paths` or `touches`; a symbolic link there always counts. Launch reads the change in the owner's checkout (`git diff --name-only --no-renames <base>...<head>`, any case, symbolic links at `.github` or below count), and a change it cannot read counts as one; `collect` then refuses the approval.

Fix limit: 3 attempts per finding (`finding_attempts`), hard stop after 6 rounds of requested changes. Reaching it blocks the builder item with a note, and `queue run` merges only an item that is `queued` on the board at that moment.

## Third-party sources

Nothing with an unknown or copyleft licence is copied into this repository; MIT and Apache-2.0 content only with its notice (`capabilities/NOTICE.md`). `capabilities/SOURCES.yaml` lists every source with its licence. `studio setup sources` fetches the referenced ones below the owner root with hooks and links off; nothing from them ever runs.

`studio sources check` holds one rule. `setup sources` records a sha256 for every file the source's contract reads and for its licence files. `fits`: every one of those files is byte-identical to its recorded hash. `unclear`: one changed, is new or is missing, or something could not be read; the output names the files, and a person or the lead reads the diff. `conflict`: a licence file is missing or changed. Files outside the contract are not judged, because they never reach a crew. A brief copies a fetched file only when it still matches its hash; otherwise the row reads `skipped:`. It installs nothing, not even a `fits`. `studio sources apply <id>` judges the candidate again and adopts only a `fits`; there is no command that adopts a held update.

## Role memory

`.studio/roles/<role>.md` holds the role's brief and a `## Lessons` section of at most 40 lines. `collect` stores a report's lessons as proposals in the state root; only `studio lessons accept <n>` moves one into the file, which the lead then commits. Lessons are crew text: `lessons list` says so, each is reduced to one plain line, and a brief shows them in a labelled data block apart from the role's instructions.

## Metrics and learning

`studio metrics` adds change failure rate (deploys followed by an incident, over deploys; `null` without a deploy), median time to restore and open incidents to lead time and deploy frequency, from `studio deploy record` and `studio incident open|resolve`. An incident counts against the latest deploy before it, once per deploy.

`studio flaky record <test> <sha> pass` counts a test that failed and passed on a rerun; `fail` is a real failure and is not recorded, because nothing is retried into green. `studio flaky` lists the worst first, for a scheduled fix item.

`.studio/solutions/*.md` is a store of earlier solutions, one file per topic with a `# Title`. `studio solutions search`, `studio plan` and builder and designer briefs answer with paths and titles.

## Using your own runners

`studio setup ci` reads the runners GitHub shows for your repository and proposes the `ci:` block of `.studio/studio.yaml`. It needs `primary_repo` (`owner/name`) in that file and a logged-in `gh`.

- **Detection.** It lists the organisation's runners first and the repository's runners as a fallback. Runners with the `self-hosted` label are grouped by their exact label set; the largest group becomes `runner_labels`, `ci.capacity.total` is its size, and a name prefix shared by the group becomes an anchored `runner_name_pattern`. If a read fails, the result is "unknown" and nothing is proposed. Without any self-hosted runner it proposes `github-hosted`, and so it does when self-hosted runners exist but all workflows use GitHub-hosted labels (a job whose runner cannot be classified, such as an expression, a group alone or a reusable workflow, keeps the runners in the proposal); a note then names how many runners stay unused. Workflows that use both kinds of runner give `runners: both`. Organisation runners restricted to other repositories by runner groups are counted, because the API call does not show those restrictions. Capacity supports organisation runners only: with repository-level runners, or when a read finds no runner matching `runner_name_pattern`, it reports fully busy with an error instead of idle.
- **Labels.** The command also lints `.github/workflows/*.yml` and `*.yaml`: every job whose `runs-on` names self-hosted labels needs an online runner that carries all of them, otherwise the job would wait forever instead of failing. A `runs-on` map with `group` and `labels` is checked by its labels, with a warning that group membership cannot be verified; `group` alone only warns. Workflows triggered by both `push` and `pull_request` must use a concurrency group of the form `<prefix>-${{ github.head_ref || github.ref_name }}`, for example `ci-…`, with `cancel-in-progress: true`. The prefix may hold letters, digits, `.`, `_` and `-`. Concurrency groups are repo-wide, so two workflows sharing a group is an error naming both files when a sharer is a `push` and `pull_request` workflow with `cancel-in-progress: true`: give each its own prefix. Sharers that only deploy, with `cancel-in-progress: false`, pass.
- **Merge rule.** `merge_max_busy` is about 62% of `total` (at least 1). Studio opens pull requests and merges only while the busy self-hosted runners stay at or below it. With `runners: both`, only self-hosted runners count toward `ci_busy`; GitHub-hosted runs (in progress plus queued) are counted separately and compared with `github_hosted_limit`. `githubHostedBusy` counts all runs of the repository, including runs whose jobs use self-hosted runners. Until you set that limit the check is skipped, and Studio says so in a warning.
- **Public repositories.** A self-hosted runner on a public repository would run code from fork pull requests, so the command reports an error and `--write` refuses to write. There is no override, even when fork pull request workflows are blocked: use GitHub-hosted runners, or edit the `ci:` block by hand at your own risk. When the visibility cannot be read, the repository counts as public.
- **Shared host.** Set `ci.shared_host: true` when the runners share their machine with other work. Capacity then also requires the 1-minute load average of the machine Studio runs on to stay at or below `ci.capacity.host_load_max`, or at the number of CPU cores when that is unset. An explicit `host_load_max` applies with or without `shared_host`.
- **Where capacity applies.** Studio gates CI load where it causes it. A launch does not wait for CI runners: a crew builds and tests in its own clone and puts no load on CI until a pull request exists. A launch of a fix, feature or chore waits only for the host load above (reason `host load` in `studio plan`), besides role WIP, credentials, overlaps, dependencies and a pause. The load average is one reading that lags behind new work, so a plan assigns at most one build; the other ready builds show `host load: one build start per plan`, and each `studio launch` reads the host again and may start one of them. When `collect` opens the pull request for a crew, it first checks the merge rule twice, `check_twice_seconds` apart, like the merge queue; a read error counts as busy. If CI has no room, nothing is opened: the item keeps its status and branch, gets the note `pr held: ci capacity (busy N of M, limit L)`, and `collect` exits 1; run `studio collect <id>` again later, and it opens the pull request once and removes the note. An item that changed during the capacity wait gets no pull request. An open pull request of the branch is taken without waiting. The merge queue keeps its own check before every merge.
- **Crew pushes.** Studio assumes a crew's `git push` of `studio/<id>` starts no CI and does not block that push. A workflow whose `push` trigger matches crew branches (no branch filter, `**`, `studio/*` and the like) would start CI on every crew push that no capacity check sees, so `setup ci` warns about it. Limit `on.push.branches` to the default branch and let `pull_request` run the checks.

Without `--write` nothing changes. With `--write` the command changes only the `ci:` block (other keys and comments stay, but comments inside a replaced list are lost), validates the whole file first, and writes it atomically. Any error, from the proposal or from the workflow lint, makes it write nothing and exit 1. `--json` prints one object with `detection`, `proposal` (`ci`, `notes`), `errors`, `warnings` and `written`.

## Claude accounts

Studio can keep the Claude login of crews apart from your own. You store a long-lived token per account; crews then use it with their own Claude config dir, so logging in or switching accounts in your own sessions never changes theirs. You are responsible for using your accounts within the terms that apply to them.

1. `claude setup-token`: creates a token valid for one year and prints it. It needs a Pro, Max, Ultra, Team or Enterprise plan.
2. `studio account add <label>`: asks for the token with hidden input and stores it. The first account becomes the active one and sets up the crew config dir.
3. `studio doctor`: shows the accounts, which one is active and how crews log in.

`studio account list` shows each label with the day it was added, whether it is free, parked until a reset, blocked or at its limit, and its runs today; never a token. `studio account use <label>` makes another account the active one. `studio account remove <label>` removes one, and refuses while a crew runs on it. `add`, `use`, `remove` and `setup-plugins` are for the owner and need a terminal; `remove` refuses while a launch is in progress, and warns when the last account goes, since launches then use the environment or your main login again. Crews use the active account only: while it is parked, blocked or at its limit, nothing starts until it is free again.

Studio checks only that a token has a plausible form (no spaces or control characters, 20 to 4096 characters). The Claude Code documentation names no way to check a token without a model call, so a wrong token shows up only when a crew starts. `account list` and `doctor` warn from 30 days before one year has passed since a token was added; after that a launch refuses and names `claude setup-token`.

**Crew config dir.** Crews of stored accounts use `$XDG_CONFIG_HOME/studio/claude` (default `~/.config/studio/claude`, mode 0700) as `CLAUDE_CONFIG_DIR`, never `~/.claude`. The first `account add` installs the `superpowers` and `studio` plugins there; `studio account setup-plugins` does it again. It runs `claude plugin marketplace add` with the HTTPS addresses of both marketplaces and `claude plugin install` with only `CLAUDE_CONFIG_DIR`, `HOME` and `PATH` in the environment, no token. A launch refuses while this directory is missing, and a role whose required skill is missing there, as for any config dir.

**Which way a launch takes.** A configured `crew_credential_command` comes first and is unchanged. Without one, stored accounts come next, with the active label. Without accounts, the environment and your normal Claude login are used, as before, under the label `default`.

## Crew credentials and usage limits

**GitHub token.** `studio secret set crew-token` asks for the token with hidden input (it refuses without a terminal), strips whitespace, checks the token once against the GitHub API for `primary_repo`, and only then writes `$XDG_CONFIG_HOME/studio/crew-token` (default `~/.config/studio/crew-token`) with mode 0600. It prints `valid for <repo>` or the failing permission and nothing from `gh`; after a failed check nothing changes. The check shows the token can use the repository; it does not prove the token's scope, so check yourself that it is least-privilege. At launch a `crew_token.env` variable that is set comes first, then this file. A file with a mode wider than 0600 or another owner makes the launch refuse.

**`studio doctor`** shows how crews log in to Claude (credential provider, the active stored account, a token in the environment, or your main login), the stored accounts with their state and expiry, and lists the crew token and its source, the credential provider, `allow_api_billing`, the names of API key variables in the environment and whether `studio.yaml` and the owner config are readable. It never prints a value. It exits 1 when the crew token is missing, unless `allow_ambient_credentials: true`.

**API billing** stays off unless the owner config sets `allow_api_billing: true`. Then `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` pass through to the crew. Without it, a launch also refuses when the `settings.json` in the crew's Claude config dir sets `apiKeyHelper`, `env.ANTHROPIC_API_KEY` or `env.ANTHROPIC_AUTH_TOKEN`. An unparsable settings file, or one that is not a regular file, refuses in either case. Crew settings written by Studio never contain `apiKeyHelper`.

**Settings sources.** Crews ignore the project and local Claude Code settings of the clone (`.claude/settings.json`, `.claude/settings.local.json`): Studio starts every crew, fresh or resumed, with `--setting-sources user`, so only the user settings and the file Studio passes with `--settings` apply. Hooks, `env` and `apiKeyHelper` from the repository therefore have no effect, and Studio no longer reads those files. Crews also do not auto-load the project `CLAUDE.md`, rules, skills, commands or subagents; Studio reads `AGENTS.md` and `CLAUDE.md` itself, in the owner's checkout, at the SHA of a freshly fetched `origin/main` (replace objects ignored), and saves copies next to the crew's brief in the state root (`briefs/<id>.rules/`); the brief points to those copies. The crew can read them but not write them, and a reused clone with moved refs cannot change them. A launch refuses when the fetch fails, when an entry is not a plain file (mode 100644, so no symlinks) or when a file is over 256 KiB. Items in another repository get the rules of the project checkout. The guard denies `git update-ref`, `git replace`, `git symbolic-ref` and fetch refspecs that write below `refs/remotes/`. Claude Code auto memory is off for crew runs (`autoMemoryEnabled: false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). These files cannot change settings or Studio's rules, and can never direct a crew to handle credentials, change remotes, reach new hosts or change the report contract. Before a launch, Studio refuses a role whose required skill is definitely absent from the crew's Claude config dir (`skills/<name>/SKILL.md` or a plugin cache `skills/<name>/SKILL.md`, any `plugin:` prefix stripped); an unreadable directory does not refuse. A required skill that is not available in the session means a `blocked` report naming it.

**Credential provider.** You can set `crew_credential_command` in the owner config (it is refused in `studio.yaml`). It is the absolute path of an executable file you own that neither group nor others can write. Studio runs it without a shell, with a 30 s timeout, and with only `PATH`, `HOME`, `STUDIO_ITEM`, `STUDIO_ROLE` (both empty when a plan only asks whether a credential is available) and `STUDIO_EXCLUDE` (comma-separated labels that are parked). It reads exactly one JSON line from stdout, at most 64 KiB; stderr is discarded:

```json
{ "label": "label-a", "env": { "CLAUDE_CONFIG_DIR": "/absolute/path/below/the/owner/config/dir" } }
```

`env` has exactly one key: `CLAUDE_CODE_OAUTH_TOKEN`, the verified fallback, or `CLAUDE_CONFIG_DIR`, which is also accepted (a login directory that must exist, belong to you and have a real path below the owner config dir). The config dir form has not yet been verified with an isolated `HOME` on macOS. The label matches `^[A-Za-z0-9._-]{1,64}$`. Only the label goes into state and board; a token reaches only the environment of the crew process. Any failure, a parked label in the answer, or an empty answer while no label is parked keeps the crew from starting. Without a provider Studio uses stored accounts (see "Claude accounts"), else the environment as described under Prerequisites, under the label `default`.

**Stored accounts, as a contract for providers.** A provider may hand out the tokens that `studio account add` stores, without its own copy. The layout is stable within a major version:

- `$XDG_CONFIG_HOME/studio/tokens/` (default `~/.config/studio/tokens/`): a directory, mode 0700, owned by the user, no symlink.
- `tokens/<label>.json`: one per account, mode 0600, owned by the user, no symlink, holding one JSON object `{"label": "<label>", "token": "<token>", "addedAt": "<ISO 8601 time>"}`. `label` equals the file name without `.json` and matches `^[A-Za-z0-9._-]{1,64}$`, not starting with a dot.
- `tokens/active`: mode 0600, the active label and a newline.
- `$XDG_CONFIG_HOME/studio/claude/`: the crew config dir with the plugins. For these tokens a provider returns `CLAUDE_CODE_OAUTH_TOKEN`.

Whenever a provider answers in the `CLAUDE_CODE_OAUTH_TOKEN` form, for a stored account or any other token, the crew gets this crew config dir as `CLAUDE_CONFIG_DIR`, as on the built-in way, never `~/.claude`; a launch refuses while it is missing (`studio account setup-plugins`). The `CLAUDE_CONFIG_DIR` form keeps the directory the provider names.

Studio reads these files only when no provider is configured. A provider reading them must apply the same checks (owner, mode, no link) and must never print a token except in its one JSON line.

**Usage limits.** At the start of `status`, `plan`, `launch` and `state`, Studio reads the end of each active crew's log. Only events Claude Code itself emits count; tool output that quotes a limit message does not. A `rate_limit` retry alone never stops a running crew; it counts only when the crew exited without a report and no later successful event shows it recovered. On a limit it stops the run, parks the label in `limits.json` in the owner root, for all projects, and returns the item to `ready` with a note; clone and branch stay. A label is parked until the reset when the event gives an absolute time, otherwise for one hour, and clears by itself afterwards. The next launch resumes the session when the clone is still there and the session is usable with the new credential (same label, or the token form with the same config dir), otherwise it starts fresh. A crew that left a report is not treated as limited, and a clone that left its branch is not replaced: the launch refuses and names it.

When no credential is available (without a provider: `default` is parked; with one: it answers empty while labels are parked), nothing is planned or started, and `state.json` shows one `forOwner` line with the earliest reset. Work continues by itself once a label is free. An unreadable `limits.json` counts as all parked and is reported.

**Usage limits per credential.** Each credential label has a ceiling set in the owner config under `crew_label_limits`: `max_parallel` (default 2) crews running at once, and optionally `max_runs_per_day` crew launches per day; `timezone` (an IANA name such as `Europe/Berlin`, default the system zone) decides where the day ends. A crew counts as running while its process is alive, whatever the board says. A launch counts when the crew is started, also when the start fails. Counts per day and label are kept in `usage.json` in the owner root and shown in `state.json` as `labelUsage` (labels only). A label at its limit is added to `STUDIO_EXCLUDE` like a parked one; a provider that returns it anyway makes the launch refuse. `plan` asks the provider with a growing exclude list (at most 16 calls, token never kept) and plans only as many items as the free labels allow; the rest wait with the reason `credential limit`, and with no free label `state.json` shows one `usage-limit` line. A provider must honour `STUDIO_EXCLUDE`: one that returns an excluded label makes the launch refuse and also holds `plan` (nothing is planned), even when no label is full. A live crew counts whatever the board says about its item. The counts are owner-wide, like account blocks and parks: two projects using the same credential share its limits. A crew stays running when another project parks its label; it hits the limit itself. An unreadable `usage.json` counts as all labels full, and an unreadable `crew.json` in any project refuses launches, since its crews cannot be counted. Launches of all projects are serialised with a `launch.lock` in the owner root, and the checks run again under the lock, after the clone is prepared and just before the run is counted and started; a launch that lost the lock refuses.

**Account blocks.** When an account looks blocked, Studio stops, so automation never makes it worse. At the start of `status`, `plan`, `launch` and `state`, it looks in the current run of every crew not yet stopped on an `assigned` or `in_progress` item, and of every running crew it can verify in another unfinished status, for events Claude Code itself emits: a failed authentication (also with no earlier success), an account on hold, disabled, suspended or banned, a disabled organization, a usage policy refusal. Tool output that quotes such a message does not count, and neither do billing errors or usage limits. A retry with a block category counts at once, also for a running crew, unless a later successful event shows the run recovered; a crew that left a report still counts.

Studio records the label and a reason code in `blocks.json` in the owner root (`<state base>/owner`), then stops every running crew of all your projects, of all labels, except on `merged` and `dropped` items, also when a board cannot be read. Another project's board is only read; its items move back the next time Studio runs there. It signals a crew only when the process start time stored at launch still matches; a running crew it cannot verify is not signalled but reported with item and pid, so check it by hand. `assigned` and `in_progress` items return to `ready` with a note; clone and branch stay. An item whose crew left a report stays where it is, so `collect` still works. Nothing starts and no credential provider is called while any block exists, under any label. `state.json` shows one `forOwner` line (`account-block`) and one entry per block under `notifications`. An unreadable `blocks.json` (malformed, a symlink, not a file) counts as blocked in the same way; a missing file means no block.

Nothing clears by itself. `studio accounts-clear <label>` removes that label's entries, moves the scan start of that label's crews in all projects to the end of their logs so an old event does not return, restarts nothing, and needs a terminal. Crews cannot write the owner root, because the sandbox lets them write only their own clone, tmp dir and `HOME`; those lie below the state base, but not in the owner root. On an unreadable file it refuses: inspect or remove the file.

**Upgrading.** Older versions kept `blocks.json`, `limits.json` and `usage.json` per project. The first command that needs them merges them into the owner root and removes the old files: blocks by label and reason with the earliest time, per label the later park, usage summed. A file that cannot be read is not interpreted. It is kept as `<owner root>/<name>.legacy-<project root>` (for a symlink, only a note), and until you inspect and remove that entry the file counts as unreadable, so nothing starts.

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection. The guard does not contain a malicious crew: `package.json` scripts, and any program a crew writes, can run anything, so no list of denied commands can stop one. Owner-only commands (`pause`, `resume`, `accounts-clear`) need a terminal, which a crew does not have; that is the real barrier for them.

Layers, outermost first:

1. Sandbox: crew shell commands run sandboxed. Each item gets its own blob-less clone (no `git worktree` on the owner's repository) and an isolated, freshly recreated `HOME` that holds only a git identity and a credential helper reading the crew token. The clone is made from the project's origin, then its `origin` is set to `https://github.com/<item repo>.git`, so the crew pushes over HTTPS with the crew token even when the owner's origin is an ssh URL. An item's `repo` must be `primary_repo` or listed in `repos`; launch refuses anything else. Writes are limited to that clone, a per-item tmp dir and that `HOME`. Reads deny the whole real home directory (plus explicit credential locations such as `gh`, ssh, netrc, gnupg, aws, docker and keychain paths, and `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` entries when set); only the clone, the tmp dir, the crew `HOME` and the real paths of the owner's `crew_toolchain_paths` (see below; nothing is derived from `PATH`) are allowed back in. Studio never runs git inside a crew clone after the crew started.
2. Least-privilege token: the crew token cannot merge, release or administer.
3. Server-side branch protection: `main` and every ref listed in `crew_allowed_workflow_refs` must be protected on the server. `loadConfig` callers can read `configWarnings(config)` for a reminder.
4. Guard hook: allows only the tools a crew needs (Bash, Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, Skill, TodoWrite, Task, Agent) and denies every other tool, including WebFetch, WebSearch and all MCP tools (crew settings deny these too, and crew sessions start with `--strict-mcp-config` and an empty MCP config). It denies risky constructs outright (force pushes, tag pushes, merges, deploys, writes outside the worktree, secret files, `eval`, shells with command strings, `xargs`, command substitution inside `git` and `gh`, running `studio` directly, `node` except `--version`, `--help`, `--test` with relative paths or plain patterns, or a literal relative script path, unquoted arithmetic and `${VAR:=x}`, `npx`, `pnpx`, `bunx`, `bun x`, `corepack`, `dlx`, `create` and `init` of npm, pnpm, yarn and bun, `npm x` and `npm exec`, `--shell*` and `--script-shell`, setting or unsetting `STUDIO_*`, `NODE_PATH`, `PATH`, `HOME` and package manager variables). These are conveniences that catch mistakes, not a wall. The hook blocks the call when node or the guard script is missing. Crew sessions write commit messages with `git commit -F <file>` and pull request bodies with `gh pr create --body-file <file>`. The guard allows listed forms, not a model of gh's or git's option grammar: `gh pr view|checks|diff|list|status` and exactly `gh pr create --head studio/<id> --base <item base> --title <text> --body-file <file>` from the clone root (each option once, the file a relative path inside the clone), `gh workflow run <listed> --ref <listed>` when `crew_allowed_workflows` is set, no other gh; git global options from a short list; `git fetch` and `git pull` with listed options from `origin` only, `git ls-remote origin [<ref>...]`, `git push` to `origin` only, all from the clone root; no `git clone`, `init`, `fetch-pack` or `archive --remote`/`--output`; `git remote` and `git submodule` only to read; no writes below any `.git`.

npm, pnpm, yarn and bun pass with any command and any option (`--filter`, `-C`, `-r`), except the denylist above; a crew runs an installed tool with `pnpm exec <tool>`. `node` takes `--version`, `--help`, `--test [<relative paths or patterns>]` or a plain relative script path. A pattern after `--test` follows the same allowlist as Glob patterns (letters, digits, `_ - . / * ? , { }`, flat braces, no `..`), and one that could name the studio binary is refused. Variable names are matched case-sensitively, except `npm_config_*`.

## State root and owner config

Runtime state never lives in the repository. Per project it goes to `$XDG_STATE_HOME/studio/<hash>-<name>` (default `~/.local/state/studio/<hash>-<name>`; `<hash>` is the first 16 hex digits of the SHA-256 of the project directory's real path, `<name>` its sanitised base name): clones, crew homes, tmp dirs, settings, briefs, logs, guard contexts, `crew.json` and `marker.json`. The marker binds the root to the project's real path and origin URL; a launch with a mismatching marker, or into a non-empty root without one, is refused, and so is a state root that equals, lies inside or contains the project directory. A reused clone must still name the project's origin in its `.git/config` (read as a file), otherwise it is cloned again. Directories are created with mode 0700; Studio refuses to write or delete through a symlink below that root. Crew shell commands cannot read the state base `…/studio` except their own clone, tmp dir and home. The project's `.studio/` keeps `studio.yaml`, `board.yaml` and `roles/` (committed) and `reports/` (crew reports, written untracked in the crew clone as the last step).

Settings that open reads on the owner's machine are not the repository's call. They live in the owner config `$XDG_CONFIG_HOME/studio/config.yaml` (default `~/.config/studio/config.yaml`; schema `schema/owner.schema.json`; a missing file means defaults):

```yaml
crew_toolchain_paths: [] # absolute directories a crew may read, e.g. a version manager's install dir
crew_allow_macos_trust_service: false # true lets crew shells on macOS reach the TLS trust service so gh works; weakens the network boundary, see SECURITY.md
crew_credential_command: /absolute/path/to/provider # optional, see "Crew credentials and usage limits"
allow_api_billing: false # true lets crew runs bill the API
# notify: { channel: my-channel, command: /absolute/path/to/notify } # optional push, see below
crew_label_limits: # usage limits per credential label, see "Usage limits per credential"
  max_parallel: 2 # crews running at once per label
  # max_runs_per_day: 20 # optional launches per label and day
  # timezone: Europe/Berlin # optional, where the day ends; default the system zone
```

Tools installed below your home, such as `cargo` from rustup or `node` from a version manager, run in a crew only when their directories are listed here; `studio doctor` names any it finds on `PATH` that are not. For Rust list `~/.cargo/bin` and `~/.rustup`, never `~/.cargo` itself, which holds the registry credentials and is refused. Crews then get `RUSTUP_HOME` pointing to the rustup dir (read-only) and `CARGO_HOME` in their own `HOME`, so crates are fetched again per run and `~/.cargo/credentials*` stay denied.

A `studio.yaml` that still contains `crew_toolchain_paths` is refused. At launch every toolchain path must exist; Studio resolves it to its real path (which goes into the sandbox) and refuses it, comparing literal and real spellings and case-insensitively on macOS, when it is the home or a parent of it, equals, contains or lies inside a credential store, `~/.claude` or `CLAUDE_CONFIG_DIR`, or equals, contains or lies inside the project directory or the state root.

**Push notifications.** With `notify: { channel, command }` in the owner config (a `notify` block in `studio.yaml` stays parsed, has no effect, and `studio` warns), `studio state` hands each line for you and each account block to `command` once. `channel` matches `[A-Za-z0-9._-]{1,64}`; `command` is checked like the credential provider (absolute, a regular file you own, not group- or world-writable) and runs without a shell, with a 30 s timeout, output ignored. Its environment is exactly `PATH`, `HOME`, `STUDIO_NOTIFY_CHANNEL`, `STUDIO_NOTIFY_KIND` (`owner-item`, `usage-limit` or `account-block`), `STUDIO_NOTIFY_ID`, `STUDIO_NOTIFY_PROJECT` and `STUDIO_NOTIFY_TEXT` (control characters replaced by spaces, at most 500 characters). Sent messages are remembered in `notified.json` in the owner state root; a failing command is retried on the next run, a line that vanishes and returns is sent again, at most 20 are sent per run, and an unreadable `notified.json` sends nothing. `studio doctor` shows only whether notify is set.
