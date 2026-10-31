# studio

Studio is a Claude Code plugin and TypeScript package for running a small software studio of coding-agent sessions from one control room: a lead session plans work from a board and a crew of role-based sessions carries it out, each in its own sandboxed clone.

Status: 0.1.0, stage (a) (board, planner, capacity, crew launch, guard, merge queue). See [CHANGELOG.md](CHANGELOG.md).

## Install

```
/plugin marketplace add Besser-Sehen-Landshut/studio
/plugin install studio@studio-marketplace
```

The plugin ships two skills (`studio:studio-lead` for the control room, `studio:studio-crew` for crew sessions) and a self-contained CLI. Claude Code puts a plugin's `bin/` on the Bash tool's `PATH` ([plugins reference, "Standard layout"](https://code.claude.com/docs/en/plugins-reference)), so the lead session simply runs `studio <command>`. Outside Claude Code, run `node <plugin>/bin/studio <command>`. The plugin needs no `pnpm install`: `bin/` loads the committed bundles in `dist-bundle/` (rebuilt with `pnpm bundle`; CI fails if they drift from `src/`).

## Prerequisites

- Claude Code CLI, `git`, and `gh` (authenticated for the control room's own use).
- Node.js 24 or newer on `PATH` (the CLI and the crew guard hook run on it).
- A least-privilege crew token created by the repository owner (for example a fine-grained token limited to the project's repositories: contents and pull requests read/write, no administration, no merge rights beyond what branch protection allows). Export it in the control room's environment and name the variable in `studio.yaml` under `crew_token.env`. Launch refuses without it unless `allow_ambient_credentials: true`.
- Server-side branch protection on `main` and on every ref listed in `crew_allowed_workflow_refs`.
- A platform where Claude Code's sandbox is supported.

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
  builder: { model: strongest, wip: 2 }
  reviewer: { model: strongest, wip: 1 }
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
| `plan`                  | Dry-run the planner (JSON: assign, blocked, deferred)         |
| `launch <id>`           | Start a crew session for a planned item                       |
| `status`                | Crew sessions and their board status                          |
| `collect <id>`          | Verify a crew report and PR head, move the item               |
| `queue add <repo>#<pr>` | Put a reviewed PR into the merge queue                        |
| `queue run`             | Merge queued PRs one at a time (exact head SHA, checks green) |
| `state`                 | Refresh `state.json` in the state root                        |
| `stop <id>`             | Stop a crew session                                           |
| `metrics`               | Lead time and deployment frequency                            |

`queue run` is meant to run in the background. It holds a lock in the state root (a second run exits 1 with "queue already running"; a lock older than 6 h is taken over with a note), picks up PRs added with `queue add` while it runs, and moves each board item as soon as its PR is done. On start it first applies results a previous run recorded but did not put on the board. Right after a head change (branch update or new push) a PR without any reported check counts as pending for 5 minutes, then fails with "no checks reported". `merge.strategy: native-queue` is not supported yet: `queue add` and `queue run` refuse it.

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
```

A `studio.yaml` that still contains `crew_toolchain_paths` is refused. At launch every toolchain path must exist; Studio resolves it to its real path (which goes into the sandbox) and refuses it, comparing literal and real spellings and case-insensitively on macOS, when it is the home or a parent of it, equals, contains or lies inside a credential store, `~/.claude` or `CLAUDE_CONFIG_DIR`, or equals, contains or lies inside the project directory or the state root.
