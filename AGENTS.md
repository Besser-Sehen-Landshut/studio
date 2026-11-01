# Studio

Studio is a Claude Code plugin and TypeScript package for running a small software studio of coding-agent sessions. One control-room (lead) session plans work from a board and drives a crew of role-based sessions, one per work item, each in its own sandboxed clone.

Stack: Node >= 24, TypeScript, pnpm >= 12.7.0 (pinned in `package.json`), vitest, zod, Biome for linting, esbuild bundles committed in `dist-bundle/`. The plugin needs no `pnpm install` at runtime: `bin/` loads the committed bundles.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm test        # vitest run; must print a test count, never 0 tests
pnpm test:mod    # the board mod's tests under claude plugin test, on a copy holding only the mod; needs the claude CLI; not run in CI, local only
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit
pnpm bundle      # rebuild dist-bundle/ from src/
pnpm build       # tsc build + JSON Schema generation (schema/)
```

Bundle drift check (what CI runs): `pnpm bundle`, then `git status --porcelain -- dist-bundle` must print nothing. Commit rebuilt bundles together with the source change.

`pnpm test` includes `test/no-private-strings.test.ts`, which needs the word list in `STUDIO_PRIVATE_WORDS`. Without it that one test fails; outside CI, run the rest and say so. Never write the word list into the repo.

## Hard rules

- **Public repo.** Never commit private names, hostnames, IPs, local paths, or company, customer, or project names. Tests enforce this: a pattern denylist (`test/denylist.txt`) plus a word list from the masked CI secret `STUDIO_PRIVATE_WORDS`.
- **CI runs only on GitHub-hosted runners** (`ubuntu-latest`), because forks run it too. Do not add self-hosted runner labels. Fork pull requests get no secrets, so only they may run with an empty word list (`STUDIO_PRIVATE_WORDS_OPTIONAL`).
- **Git hygiene.** Stage files by name, never `git add -A` or `git add .`. No force-push. Work on a branch and open a PR.
- **`main` is protected:** changes arrive by pull request with the checks `check` (lint, typecheck, bundle drift, tests) and `secrets` (gitleaks) passing.
- **The crew guard is a convenience layer, not the security boundary.** The boundary is the sandbox, a least-privilege token, and server-side branch protection. See `SECURITY.md`.
- **Skills change only after a recorded failing baseline.** Before editing anything under `skills/`, record how an agent fails without the change in `test/skills/` (`baseline-lead.md`, `baseline-crew.md`, `scenarios/`), then write the change.
- **No vendoring of unknown or copyleft content.** Third-party content goes into `capabilities/` only under MIT or Apache-2.0 with its notice in `capabilities/NOTICE.md`; everything else is listed in `capabilities/SOURCES.yaml` and fetched. Tests guard this.
- **Concurrency.** CI keeps the group `ci-${{ github.head_ref || github.ref_name }}` with `cancel-in-progress: true`; a test guards it (`test/ci-concurrency.test.ts`).

## Where things live

- `README.md`: install, prerequisites, quick start, CLI reference.
- `SECURITY.md`: vulnerability reporting and the security model.
- `CHANGELOG.md`: release notes; add an entry for user-visible changes.
- `src/`: source; `dist-bundle/`: committed bundles; `schema/`: generated JSON Schemas.
- `capabilities/`: trigger matrix, sources list, analyzers, design and knowledge files; loaded per row, never whole.
- `skills/`: the lead and crew skills; `test/`: tests, fixtures, skill baselines.
