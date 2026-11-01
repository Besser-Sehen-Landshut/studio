# Dead code (epic end and pre-release review)

**Question:** What in this codebase is no longer used — and can be removed without changing
behaviour?

Modes: `quick` (the files changed in the epic and what they used to reference) and `full` (the
whole codebase).

## Procedure

1. **Use the project's own tools first** when they exist, and read their hints about blind spots:
   `knip` or `ts-prune` (JS/TS), `cargo udeps` and compiler warnings (Rust), `vulture` (Python),
   `periphery` (Swift), `staticcheck` (Go), the IDE's unused-symbol warnings. Report their output
   through the checks below, never raw.
2. **Candidates:** unreferenced exports, functions, components, routes, CSS classes, config keys,
   feature flags that are always on or off, dependencies nobody imports, files nobody includes,
   branches behind conditions that can no longer be true.
3. **Verify every candidate by search before calling it dead.** Include what static tools miss:
   string-based lookups (hooks and filter names, reflection, dynamic imports, templates, routes
   defined by file name), stylesheets, config and build files, scripts in `package.json`/`Makefile`,
   CI workflows, tests, and other repositories or services that may call a public API.
4. **Classify:** *safe* (private and provably unreferenced), *likely* (public or referenced by name
   in a way a search cannot rule out), *keep* (used dynamically or intentionally reserved — say why).

## Output

Contract format. Severity: dead code is a **note**, except where it misleads — a config option the
code never reads while users set it, or a guard that looks active but is unreachable — then
**critical**. The lead removes *safe* items and asks before removing *likely* ones; removals
never ride along in an unrelated commit.
