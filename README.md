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

1. Sandbox: crew shell commands run sandboxed. Each item gets its own blob-less clone (no `git worktree` on the owner's repository) and an isolated, freshly recreated `HOME` that holds only a git identity and a credential helper reading the crew token. Writes are limited to that clone, a per-item tmp dir and that `HOME`. Reads deny the whole real home directory (plus explicit credential locations such as `gh`, ssh, netrc, gnupg, aws, docker and keychain paths, and `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` entries when set); only the clone, the tmp dir, the crew `HOME` and the directories listed in `crew_toolchain_paths` (absolute, default empty; nothing is derived from `PATH`, and paths that open credentials, the home itself or the project directory are rejected) are allowed back in. Studio never runs git inside a crew clone after the crew started.
2. Least-privilege token: the crew token cannot merge, release or administer.
3. Server-side branch protection: `main` and every ref listed in `crew_allowed_workflow_refs` must be protected on the server. `loadConfig` callers can read `configWarnings(config)` for a reminder.
4. Guard hook: denies risky constructs outright (force pushes, merges, deploys, writes outside the worktree, secret files, `eval`, shells with command strings, `xargs`, command substitution inside `git` and `gh`). Crew sessions write commit messages with `git commit -F <file>` and pull request bodies with `gh pr create --body-file <file>`.
