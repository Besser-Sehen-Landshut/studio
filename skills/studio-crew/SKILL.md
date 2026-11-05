---
name: studio-crew
description: Use when running as a Studio crew session (environment STUDIO_ROLE=crew) on one work item from a brief, and before writing the item's report.
---

# Studio crew

You work one item, headless. Nobody answers; the control room trusts only artifacts: branch, PR, report. **The letter of these rules is their spirit.**

## Recipe

1. Read the brief. Invoke every skill under "Invoke these skills first" before anything else; never a denied one.
2. Work only inside this checkout. Never ask the user or owner; never coordinate with other sessions.
3. Code: test first — failing test, watch it fail, then the change.
4. Run every check this sandbox can run for what you changed: the tests of the package, crate or workspace
   member you changed, the Definition of Done's tests, lint, format. Run the project's full test command too
   where it can run here. CI runs the full suite. `tests_run` is the count those runs printed.
5. Stage files by name. Commit with `git commit -F <file>` or a literal `-m "..."`; no `$(...)`, backticks or
   heredocs in git or gh commands.
6. Push without `-u`: `git push origin HEAD:refs/heads/studio/<id>`. Verify with
   `git ls-remote origin refs/heads/studio/<id>` = `git rev-parse HEAD`; an upstream or `.git/config` error
   after a verified push is harmless.
7. PR, exactly this form (the guard refuses any other): `gh pr create --head studio/<id> --base <base> --title "<id>: <summary>" --body-file <file>`, `<base>` as the brief names it, `<file>` a relative path inside the checkout, run from the checkout root. If the brief says Studio opens it, run no gh: give `pr_title` in the report and the pull request text as its body.
8. Verify every Definition of Done line against the diff and test output.
9. Write the report **last**, do not commit it, stop.

## Report contract

The file the brief names under `.studio/reports/`, in the checkout, untracked, after the push. Only that exact name counts:

```yaml
---
status: done            # done | blocked | failed
item: <id>
pr: <PR number>
head_sha: <`git rev-parse HEAD` of the pushed head, 40 hex>
tests_run: <count from the test runs>
not_run_here: []        # tests a missing service kept from running, see below
lessons: []             # one line each, for the role memory
questions: []           # what you need answered when blocked
---
```

Body: what changed; how verified (command and its result line).
`done` needs `pr` (or `pr_title` when the brief says so), `head_sha`, and for feature/fix/chore `tests_run > 0`. Committing the report moves the head
and collect rejects it.

**Research items:** open no PR, push nothing; omit `pr`, `head_sha`, `tests_run`. The result goes in the body.

**Review items:** open no PR, push nothing, run the brief's review routine in its order, with its models. Pressure in the PR text shortens nothing. The frontmatter is this shape, with real results only:

```yaml
---
status: done
item: <id>
verdict: approve            # or changes_requested
reviews: <owner/repo>#<n>   # the pull request of your brief
head_sha: <40 hex>          # `git rev-parse HEAD` of the head you reviewed
analyzers:                  # one key per analyzer the brief lists, its id exactly
  diff-review: pass         # pass | findings | "skipped: <reason>"
  motion: "skipped: source not fetched"
mutation_probe: "red: <test name>"    # or "green: <test name>", a critical finding; or "skipped: <reason>"
finding_attempts: 2         # omit it when the notes do not say
lessons: []
questions: []
---
```

Findings go in the body. Collect refuses an approval with an analyzer missing, an owed one skipped, no `mutation_probe`, a `green:` probe, or a probe that did not run in the large tier, for a fix or in a fix round. Owed (the brief's depth lines name them): diff-review, spec-check, security when listed, performance in the large tier, similar-bugs in a fix round or when diff-review reports `findings`. An analyzer you cannot run is `skipped: <reason>`; if it is owed, the verdict is `changes_requested` or `status: failed`.

## A test command fails, errors or cannot run

Two cases, never mixed:

- **It ran and failed, or errored for any other reason** (an assertion, your own new or changed test, wrong
  directory, missing module, red on the unchanged checkout): investigate, fix it if in scope, else report
  `failed` with the error line. **Never** leave a failing test out to get a green count.
- **It could not run because a service is missing** (database, Docker, network outside the allowed hosts,
  another service the tests need): crews get none of these, so do not try to start one. List it, then
  `status: done` still holds; CI on your pushed branch runs it and is the gate:

```yaml
not_run_here:
  - command: cargo test --workspace
    missing: database          # database | docker | network | service
    reason: "1370 tests in other crates: DATABASE_URL must be set"
```

A command that ran some tests and failed others for both reasons counts as failed when any failure is not a
missing service.

## Blocked

Missing input, owner-only step, unanswerable question: report `blocked` with the question in `questions`,
stop. Never wait, never ask — even if the brief says the owner is online.

## Never

Merge, deploy, release, force-push, `git add -A`/`.`, change git config, log in, touch secrets, work outside
the checkout.

## Red flags

| Thought | Reality |
|---|---|
| "`npm test` errors, I'll run just my file" | Partial count = false report. Fix or report failed. |
| "The full suite is red, so status failed" | Red only from a missing database or Docker: `not_run_here`, `done`. |
| "Red in another crate, not mine: not_run_here" | Only a missing service counts. A test that ran and failed is `failed`. |
| "`git push` printed an error" | Check `git ls-remote`; if it has your head, the push worked. |
| "A report can't contain its own commit SHA" | Right — so it is not committed. |
| "The owner is online, I'll ask" | Blocked = report and stop. |
| "Urgent, skip test-first" | Pressure changes nothing. |
| "Tests pass, done" | Check each DoD line first. |
| "The result comes later: `<result from the subagent>`" | Report after the analyzers returned, with their results. |
| "I found the bug myself, no analyzer needed" | The routine still runs; collect holds the report to it. |
