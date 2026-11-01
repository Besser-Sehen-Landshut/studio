# studio

Studio is a Claude Code plugin and TypeScript package for running a small software studio of coding-agent sessions from one control room: a lead session plans work from a board and a crew of role-based sessions carries it out, each in its own sandboxed clone.

Status: 0.2.0, stage (a) (board, planner, capacity, crew launch, guard, merge queue) with stage (a.1) (your own runners, crew credentials, usage limits). See [CHANGELOG.md](CHANGELOG.md).

## Install

```
/plugin marketplace add Besser-Sehen-Landshut/studio
/plugin install studio@studio-marketplace
```

The plugin ships two skills (`studio:studio-lead` for the control room, `studio:studio-crew` for crew sessions) and a self-contained CLI. Claude Code puts a plugin's `bin/` on the Bash tool's `PATH` ([plugins reference, "Standard layout"](https://code.claude.com/docs/en/plugins-reference)), so the lead session simply runs `studio <command>`. Outside Claude Code, run `node <plugin>/bin/studio <command>`. The plugin needs no `pnpm install`: `bin/` loads the committed bundles in `dist-bundle/` (rebuilt with `pnpm bundle`; CI fails if they drift from `src/`).

## Prerequisites

- Claude Code CLI, `git`, and `gh` (authenticated for the control room's own use).
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

| Command                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `board`                 | Show the board                                                |
| `plan`                  | Dry-run the planner (JSON incl. capacity and its read error)  |
| `launch <id>`           | Start a crew session for a planned item                       |
| `status`                | Crew sessions and their board status                          |
| `collect <id>`          | Verify a crew report and PR head, move the item               |
| `queue add <repo>#<pr>` | Put a reviewed PR into the merge queue                        |
| `queue run`             | Merge queued PRs one at a time (exact head SHA, checks green) |
| `state`                 | Refresh `state.json` in the state root                        |
| `stop <id>`             | Stop a crew session                                           |
| `metrics`               | Lead time and deployment frequency                            |
| `setup ci [--write]`    | Detect CI runners, propose the `ci:` block, lint workflows    |
| `secret set crew-token` | Store the crew's GitHub token (hidden input, checked first)   |
| `doctor`                | What is set and what is missing, never values                 |

`launch` refuses while a crew for the same item is still running and deletes a report an earlier run left in a reused clone. `collect` refuses while the item's crew process is still alive and refuses a report last modified before the crew started.

`queue run` is meant to run in the background. It holds a lock in the state root (a second run exits 1 with "queue already running" while the holder lives; the lock records pid, start and a heartbeat refreshed on every step and poll, and is taken over with a note only when that pid is gone or the heartbeat is older than 15 minutes; SIGTERM, SIGINT and SIGHUP release it), picks up PRs added with `queue add` while it runs, and moves each board item as soon as its PR is done. On start it first applies results a previous run recorded but did not put on the board. Right after a head change (branch update or new push) a PR without any reported check counts as pending for 5 minutes, then fails with "no checks reported". `merge.strategy: native-queue` is not supported yet: `queue add` and `queue run` refuse it.

## Using your own runners

`studio setup ci` reads the runners GitHub shows for your repository and proposes the `ci:` block of `.studio/studio.yaml`. It needs `primary_repo` (`owner/name`) in that file and a logged-in `gh`.

- **Detection.** It lists the organisation's runners first and the repository's runners as a fallback. Runners with the `self-hosted` label are grouped by their exact label set; the largest group becomes `runner_labels`, `ci.capacity.total` is its size, and a name prefix shared by the group becomes an anchored `runner_name_pattern`. If a read fails, the result is "unknown" and nothing is proposed. Without any self-hosted runner it proposes `github-hosted`, and so it does when self-hosted runners exist but all workflows use GitHub-hosted labels; a note then names how many runners stay unused. Workflows that use both kinds of runner give `runners: both`. Organisation runners restricted to other repositories by runner groups are counted, because the API call does not show those restrictions. Capacity supports organisation runners only: with repository-level runners, or when a read finds no runner matching `runner_name_pattern`, it reports fully busy with an error instead of idle.
- **Labels.** The command also lints `.github/workflows/*.yml` and `*.yaml`: every job whose `runs-on` names self-hosted labels needs an online runner that carries all of them, otherwise the job would wait forever instead of failing. A `runs-on` map with `group` and `labels` is checked by its labels, with a warning that group membership cannot be verified; `group` alone only warns. Workflows triggered by both `push` and `pull_request` must use a concurrency group of the form `<prefix>-${{ github.head_ref || github.ref_name }}`, for example `ci-…`, with `cancel-in-progress: true`. The prefix may hold letters, digits, `.`, `_` and `-`. Concurrency groups are repo-wide, so two workflows sharing a group is an error naming both files: give each its own prefix.
- **Merge rule.** `merge_max_busy` is about 62% of `total` (at least 1). Studio plans and merges only while the busy self-hosted runners stay at or below it. With `runners: both`, only self-hosted runners count toward `ci_busy`; GitHub-hosted runs (in progress plus queued) are counted separately and compared with `github_hosted_limit`. `githubHostedBusy` counts all runs of the repository, including runs whose jobs use self-hosted runners. Until you set that limit the check is skipped, and Studio says so in a warning.
- **Public repositories.** A self-hosted runner on a public repository would run code from fork pull requests, so the command reports an error and `--write` refuses to write. There is no override, even when fork pull request workflows are blocked: use GitHub-hosted runners, or edit the `ci:` block by hand at your own risk. When the visibility cannot be read, the repository counts as public.
- **Shared host.** Set `ci.shared_host: true` when the runners share their machine with other work. Capacity then also requires the 1-minute load average to stay at or below `ci.capacity.host_load_max`, or at the number of CPU cores when that is unset. An explicit `host_load_max` applies with or without `shared_host`.

Without `--write` nothing changes. With `--write` the command changes only the `ci:` block (other keys and comments stay, but comments inside a replaced list are lost), validates the whole file first, and writes it atomically. Any error, from the proposal or from the workflow lint, makes it write nothing and exit 1. `--json` prints one object with `detection`, `proposal` (`ci`, `notes`), `errors`, `warnings` and `written`.

## Crew credentials and usage limits

**GitHub token.** `studio secret set crew-token` asks for the token with hidden input (it refuses without a terminal), strips whitespace, checks the token once against the GitHub API for `primary_repo`, and only then writes `$XDG_CONFIG_HOME/studio/crew-token` (default `~/.config/studio/crew-token`) with mode 0600. It prints `valid for <repo>` or the failing permission and nothing from `gh`; after a failed check nothing changes. The check shows the token can use the repository; it does not prove the token's scope, so check yourself that it is least-privilege. At launch a `crew_token.env` variable that is set comes first, then this file. A file with a mode wider than 0600 or another owner makes the launch refuse.

**`studio doctor`** lists the crew token and its source, the credential provider, `allow_api_billing`, the names of API key variables in the environment and whether `studio.yaml` and the owner config are readable. It never prints a value. It exits 1 when the crew token is missing, unless `allow_ambient_credentials: true`.

**API billing** stays off unless the owner config sets `allow_api_billing: true`. Then `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` pass through to the crew. Without it, a launch also refuses when the `settings.json` in the crew's Claude config dir sets `apiKeyHelper`, `env.ANTHROPIC_API_KEY` or `env.ANTHROPIC_AUTH_TOKEN`. An unparsable settings file refuses in either case. Crew settings written by Studio never contain `apiKeyHelper`.

**Settings sources.** Crews ignore the project and local Claude Code settings of the clone (`.claude/settings.json`, `.claude/settings.local.json`): Studio starts every crew, fresh or resumed, with `--setting-sources user`, so only the user settings and the file Studio passes with `--settings` apply. Hooks, `env` and `apiKeyHelper` from the repository therefore have no effect, and Studio no longer reads those files. Project instructions such as an `AGENTS.md` or `CLAUDE.md` are still read as ordinary project content; they do not change settings.

**Credential provider.** You can set `crew_credential_command` in the owner config (it is refused in `studio.yaml`). It is the absolute path of an executable file you own that neither group nor others can write. Studio runs it without a shell, with a 30 s timeout, and with only `PATH`, `HOME`, `STUDIO_ITEM`, `STUDIO_ROLE` (both empty when a plan only asks whether a credential is available) and `STUDIO_EXCLUDE` (comma-separated labels that are parked). It reads exactly one JSON line from stdout, at most 64 KiB; stderr is discarded:

```json
{ "label": "label-a", "env": { "CLAUDE_CONFIG_DIR": "/absolute/path/below/the/owner/config/dir" } }
```

`env` has exactly one key: `CLAUDE_CODE_OAUTH_TOKEN`, the verified fallback, or `CLAUDE_CONFIG_DIR`, which is also accepted (a login directory that must exist, belong to you and have a real path below the owner config dir). The config dir form has not yet been verified with an isolated `HOME` on macOS. The label matches `^[A-Za-z0-9._-]{1,64}$`. Only the label goes into state and board; a token reaches only the environment of the crew process. Any failure, a parked label in the answer, or an empty answer while no label is parked keeps the crew from starting. Without a provider Studio uses the environment as described under Prerequisites, under the label `default`.

**Usage limits.** At the start of `status`, `plan`, `launch` and `state`, Studio reads the end of each active crew's log. Only events Claude Code itself emits count; tool output that quotes a limit message does not. A `rate_limit` retry alone never stops a running crew; it counts only when the crew exited without a report and no later successful event shows it recovered. On a limit it stops the run, parks the label in `limits.json` in the state root, and returns the item to `ready` with a note; clone and branch stay. A label is parked until the reset when the event gives an absolute time, otherwise for one hour, and clears by itself afterwards. The next launch resumes the session when the clone is still there and the session is usable with the new credential (same label, or the token form with the same config dir), otherwise it starts fresh. A crew that left a report is not treated as limited, and a clone that left its branch is not replaced: the launch refuses and names it.

When no credential is available (without a provider: `default` is parked; with one: it answers empty while labels are parked), nothing is planned or started, and `state.json` shows one `forOwner` line with the earliest reset. Work continues by itself once a label is free. An unreadable `limits.json` counts as all parked and is reported.

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection.

Layers, outermost first:

1. Sandbox: crew shell commands run sandboxed. Each item gets its own blob-less clone (no `git worktree` on the owner's repository) and an isolated, freshly recreated `HOME` that holds only a git identity and a credential helper reading the crew token. The clone is made from the project's origin, then its `origin` is set to `https://github.com/<item repo>.git`, so the crew pushes over HTTPS with the crew token even when the owner's origin is an ssh URL. An item's `repo` must be `primary_repo` or listed in `repos`; launch refuses anything else. Writes are limited to that clone, a per-item tmp dir and that `HOME`. Reads deny the whole real home directory (plus explicit credential locations such as `gh`, ssh, netrc, gnupg, aws, docker and keychain paths, and `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` entries when set); only the clone, the tmp dir, the crew `HOME` and the real paths of the owner's `crew_toolchain_paths` (see below; nothing is derived from `PATH`) are allowed back in. Studio never runs git inside a crew clone after the crew started.
2. Least-privilege token: the crew token cannot merge, release or administer.
3. Server-side branch protection: `main` and every ref listed in `crew_allowed_workflow_refs` must be protected on the server. `loadConfig` callers can read `configWarnings(config)` for a reminder.
4. Guard hook: allows only the tools a crew needs (Bash, Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, Skill, TodoWrite, Task, Agent) and denies every other tool, including WebFetch, WebSearch and all MCP tools (crew settings deny these too, and crew sessions start with `--strict-mcp-config` and an empty MCP config). It denies risky constructs outright (force pushes, tag pushes, merges, deploys, writes outside the worktree, secret files, `eval`, shells with command strings, `xargs`, command substitution inside `git` and `gh`). The hook blocks the call when node or the guard script is missing. Crew sessions write commit messages with `git commit -F <file>` and pull request bodies with `gh pr create --body-file <file>`.

## State root and owner config

Runtime state never lives in the repository. Per project it goes to `$XDG_STATE_HOME/studio/<hash>-<name>` (default `~/.local/state/studio/<hash>-<name>`; `<hash>` is the first 16 hex digits of the SHA-256 of the project directory's real path, `<name>` its sanitised base name): clones, crew homes, tmp dirs, settings, briefs, logs, guard contexts, `crew.json` and `marker.json`. The marker binds the root to the project's real path and origin URL; a launch with a mismatching marker, or into a non-empty root without one, is refused, and so is a state root that equals, lies inside or contains the project directory. A reused clone must still name the project's origin in its `.git/config` (read as a file), otherwise it is cloned again. Directories are created with mode 0700; Studio refuses to write or delete through a symlink below that root. Crew shell commands cannot read the state base `…/studio` except their own clone, tmp dir and home. The project's `.studio/` keeps `studio.yaml`, `board.yaml` and `roles/` (committed) and `reports/` (crew reports, written untracked in the crew clone as the last step).

Settings that open reads on the owner's machine are not the repository's call. They live in the owner config `$XDG_CONFIG_HOME/studio/config.yaml` (default `~/.config/studio/config.yaml`; schema `schema/owner.schema.json`; a missing file means defaults):

```yaml
crew_toolchain_paths: [] # absolute directories a crew may read, e.g. a version manager's install dir
crew_credential_command: /absolute/path/to/provider # optional, see "Crew credentials and usage limits"
allow_api_billing: false # true lets crew runs bill the API
```

A `studio.yaml` that still contains `crew_toolchain_paths` is refused. At launch every toolchain path must exist; Studio resolves it to its real path (which goes into the sandbox) and refuses it, comparing literal and real spellings and case-insensitively on macOS, when it is the home or a parent of it, equals, contains or lies inside a credential store, `~/.claude` or `CLAUDE_CONFIG_DIR`, or equals, contains or lies inside the project directory or the state root.
