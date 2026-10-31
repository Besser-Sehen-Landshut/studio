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

1. Sandbox: crew shell commands run sandboxed.
2. Least-privilege token: the crew token cannot merge, release or administer.
3. Server-side branch protection: `main` and every ref listed in `crew_allowed_workflow_refs` must be protected on the server. `loadConfig` callers can read `configWarnings(config)` for a reminder.
4. Guard hook: denies risky constructs outright (force pushes, merges, deploys, writes outside the worktree, secret files, `eval`, shells with command strings, `xargs`, command substitution inside `git` and `gh`). Crew sessions write commit messages with `git commit -F <file>` and pull request bodies with `gh pr create --body-file <file>`.
