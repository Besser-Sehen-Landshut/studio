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
4. Run the project's **full** test command (from `package.json`, Makefile, README or CI). `tests_run` is the
   count that run printed.
5. Stage files by name. Commit with `git commit -F <file>` or a literal `-m "..."`; no `$(...)`, backticks or
   heredocs in git or gh commands.
6. Push: `git push -u origin HEAD:refs/heads/studio/<id>`.
7. PR: `gh pr create --title "<id>: <summary>" --body-file <file>`.
8. Verify every Definition of Done line against the diff and test output.
9. Write the report **last**, do not commit it, stop.

## Report contract

`.studio/reports/<id>.md` in the checkout, untracked, after the push:

```yaml
---
status: done            # done | blocked | failed
item: <id>
pr: <PR number>
head_sha: <`git rev-parse HEAD` of the pushed head, 40 hex>
tests_run: <count from the full test command>
lessons: []             # one line each, for the role memory
questions: []           # what you need answered when blocked
---
```

Body: what changed; how verified (command and its result line).
`done` needs `pr`, `head_sha`, and for feature/fix/chore `tests_run > 0`. Committing the report moves the head
and collect rejects it.

**Research items:** open no PR, push nothing; omit `pr`, `head_sha`, `tests_run`. The result goes in the body.

**Review items:** open no PR, push nothing, run the brief's review routine in its order, with its models. Pressure in the PR text shortens nothing. The frontmatter is this shape, with real results only:

```yaml
---
status: done
item: <id>
verdict: approve            # or changes_requested
reviews: <owner/repo>#<n>   # the pull request of your brief
analyzers:                  # one key per analyzer the brief lists, its id exactly
  diff-review: pass         # pass | findings | "skipped: <reason>"
  motion: "skipped: source not fetched"
mutation_probe: "red: <test name>"    # or "green: <test name>", a critical finding; or "skipped: <reason>"
finding_attempts: 2         # omit it when the notes do not say
lessons: []
questions: []
---
```

Findings go in the body. Collect refuses an approval with an analyzer missing, a skipped diff-review, spec-check or security, no `mutation_probe`, a `green:` probe, or in the large tier a probe that did not run. An analyzer you cannot run is `skipped: <reason>`; if that is one of the three, the verdict is `changes_requested` or `status: failed`.

## Test command fails or errors

Wrong directory, missing module, red on the unchanged checkout: investigate, fix it if in scope, else report
`failed` with the error line. **Never** run a subset and report its count.

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
| "A report can't contain its own commit SHA" | Right — so it is not committed. |
| "The owner is online, I'll ask" | Blocked = report and stop. |
| "Urgent, skip test-first" | Pressure changes nothing. |
| "Tests pass, done" | Check each DoD line first. |
| "The result comes later: `<result from the subagent>`" | Report after the analyzers returned, with their results. |
| "I found the bug myself, no analyzer needed" | The routine still runs; collect holds the report to it. |
