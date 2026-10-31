# studio

Studio is a Claude Code plugin and TypeScript package for running a small software studio of coding-agent sessions from one control room: a lead session plans work from a board and a crew of role-based sessions carries it out in isolated worktrees.

Install:

```
/plugin marketplace add Besser-Sehen-Landshut/studio
/plugin install studio@studio-marketplace
```

Status: stage (a) in development

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection.

Layers, outermost first:

1. Sandbox: crew shell commands run sandboxed. Each item gets its own blob-less clone (no `git worktree` on the owner's repository) and an isolated, freshly recreated `HOME` that holds only a git identity and a credential helper reading the crew token. Writes are limited to that clone, a per-item tmp dir and that `HOME`. Reads deny the whole real home directory (plus explicit credential locations such as `gh`, ssh, netrc, gnupg, aws, docker and keychain paths, and `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` entries when set); only the clone, the tmp dir, the crew `HOME` and the real paths of the owner's `crew_toolchain_paths` (see below; nothing is derived from `PATH`) are allowed back in. Studio never runs git inside a crew clone after the crew started.
2. Least-privilege token: the crew token cannot merge, release or administer.
3. Server-side branch protection: `main` and every ref listed in `crew_allowed_workflow_refs` must be protected on the server. `loadConfig` callers can read `configWarnings(config)` for a reminder.
4. Guard hook: denies risky constructs outright (force pushes, merges, deploys, writes outside the worktree, secret files, `eval`, shells with command strings, `xargs`, command substitution inside `git` and `gh`). Crew sessions write commit messages with `git commit -F <file>` and pull request bodies with `gh pr create --body-file <file>`.

## State root and owner config

Runtime state never lives in the repository. Per project it goes to `$XDG_STATE_HOME/studio/<hash>-<name>` (default `~/.local/state/studio/<hash>-<name>`; `<hash>` is the first 16 hex digits of the SHA-256 of the project directory's real path, `<name>` its sanitised base name): clones, crew homes, tmp dirs, settings, briefs, logs, guard contexts, `crew.json` and `marker.json`. The marker binds the root to the project's real path and origin URL; a launch with a mismatching marker, or into a non-empty root without one, is refused, and so is a state root that equals, lies inside or contains the project directory. A reused clone must still name the project's origin in its `.git/config` (read as a file), otherwise it is cloned again. Directories are created with mode 0700; Studio refuses to write or delete through a symlink below that root. Crew shell commands cannot read the state base `…/studio` except their own clone, tmp dir and home. The project's `.studio/` keeps `studio.yaml`, `board.yaml` and `roles/` (committed) and `reports/` (crew reports, written untracked in the crew clone as the last step).

Settings that open reads on the owner's machine are not the repository's call. They live in the owner config `$XDG_CONFIG_HOME/studio/config.yaml` (default `~/.config/studio/config.yaml`; schema `schema/owner.schema.json`; a missing file means defaults):

```yaml
crew_toolchain_paths: [] # absolute directories a crew may read, e.g. a version manager's install dir
```

A `studio.yaml` that still contains `crew_toolchain_paths` is refused. At launch every toolchain path must exist; Studio resolves it to its real path (which goes into the sandbox) and refuses it, comparing literal and real spellings and case-insensitively on macOS, when it is the home or a parent of it, equals, contains or lies inside a credential store, `~/.claude` or `CLAUDE_CONFIG_DIR`, or equals, contains or lies inside the project directory or the state root.
