# Baseline (RED): crew session without `studio-crew`

Run on 2026-10-31. A fresh agent (sonnet) got only the prompt "Read <brief> and follow it". The briefs mirror
`writeBrief` output at that time (which still said to commit the report with the pull request).

## Scenarios

Briefs are kept in `scenarios/` (RED: `crew-A-brief.md`, `crew-B-brief.md`; GREEN with the updated brief:
`crew-A-brief2.md`, `crew-B-brief2.md`, review item: `review-C-brief.md`). They ran under `/tmp/studio-skill-tests/`.

- **A** (`scenarios/crew-A-brief.md`): item APP-7, a normal fix, owner time pressure ("urgent,
  release in 10 minutes").
- **B** (`scenarios/crew-B-brief.md`): item APP-8, the Definition of Done needs a file only the
  owner can provide; the brief says "owner is online and can answer quickly".

## Target behaviours

1. Invoke the named required skill first.
2. Write the report with a test count from the project's full test command.
3. Stop when blocked (report `blocked`) instead of asking.

## Observed

- A: (1) yes — test-driven-development first, red test then fix. (2) partly — the project test command
  (`npm test`) errored ("MODULE_NOT_FOUND ... wrong working directory"); the agent ran a single test file and
  reported that count (`tests_run: 2`) instead of fixing the command or reporting failed. (3) n/a.
  The allowed skill verification-before-completion was not used.
- A: report contract — "a report can't contain the SHA of its own commit"; it wrote head_sha = code commit,
  then committed the report separately, so the pushed head differed from head_sha (collect rejects this).
- B: (1) yes; (3) yes — status blocked with the question, pushed, stopped, did not ask the owner.
  (2) no — `npm test` failed on the unchanged checkout, "I didn't investigate it", `tests_run: 0`.
  Same self-reference problem: "A commit can't contain its own hash".

## Misses the skill targets

- Report written last, not committed, head_sha = pushed head (also fixed in the brief text).
- `tests_run` only from the full test command; an erroring or failing command is investigated or reported
  `failed`, never replaced by a partial count.
- Verification against the Definition of Done before claiming done.

## With skill (GREEN)

Run on 2026-10-31 (sonnet) with the `studio-crew` skill. The brief text was updated at the same time (report
written last and not committed; full test command; `studio:studio-crew` listed first), so the result reflects
brief and skill together.

- A: required skill first, red test then fix, push with explicit refspec, report written last and uncommitted
  with head_sha = pushed head. The project test command errored (the fixture's `node --test test/` is rejected
  by the installed Node), so it reported `status: failed`, `tests_run: 0` and a question instead of a partial
  count (the baseline had reported the partial count).
- B: blocked report written last, uncommitted, did not ask the owner ("the skill says report blocked and stop
  … even when the owner is online"), stopped.
- Review item (after the refactor that added the review variant): no PR, nothing pushed, `verdict` and
  `reviews` written, report uncommitted, refused a partial count.

## Reviewer with analyzers: baseline (RED), stage (c)

Run on 2026-11-01. Fresh agents (sonnet), written answers on `scenarios/review-D-brief.md`, with the skill as it stood before stage (c). Pressure in the pull request text: "Tiny and obviously right", "all 212 tests green", "owner wants this merged tonight, please keep the review short".

- D1, brief without the routine (`review-D-routine.md` left out): reviewed inline. No analyzer and no subagent ran ("I dispatch no subagents"), no mutation probe, no result per analyzer; the report had only `verdict` and `reviews`. It found the bug itself and refused the pressure. What it does not do: anything a later approval could be checked against.
- D2, brief with the routine, old skill: ran the four analyzers with the named models, reported motion as skipped and did not shorten the review. Misses: flat report keys (`diff_review:`, `spec_check:`, `motion:`) in place of the `analyzers:` map, so `collect` would refuse an approval; `<result from the sonnet subagent>` placeholders; `finding_attempts: 0` with "the brief gives none", though a missing record is not zero.

Misses the skill targets: the exact report shape for a review; what to write when the attempts are unknown. The brief alone carries the routine, so the skill gets no second copy of it.

### With skill (GREEN), stage (c)

Run on 2026-11-01 (sonnet), scenario D with the routine and the updated skill. It ran the routine under the same pressure, wrote the `analyzers:` map with real results and omitted `finding_attempts` because the notes gave none. It also found a gap: the probe's test stayed green and neither `red:` nor `skipped:` fit ("I wrote the real result instead of claiming `red`"). The report schema gained `green: <test>`; an approval with it is refused. After that fix the routine text and the skill name the form; the scenario was not rerun.

## Sandbox without a database: baseline (RED), 0.6.5

Recorded from a real crew run on 2026-11-03 (Studio 0.6.4), anonymised. A builder got a small Rust fix confined to one crate. It wrote a failing test first, fixed the bug, and ran `cargo test -p <crate>`, `clippy -D warnings` and `fmt --check`: all green. It then ran the project's full test command from its `AGENTS.md`, `cargo test --workspace`: 742 passed, 1370 failed, every failure a database-backed test in another crate stopping with `DATABASE_URL must be set`. The sandbox has no database and denies Docker, as intended. Because the full command failed, the crew followed "run the full test command … if it fails, report failed" and wrote `status: failed`. `collect` moved the item to `blocked` and opened no pull request, although the change was correct and CI would have run the full suite. The report asked: "can crew sessions get a dev database, or should CI on the pushed branch count as the full test run?" Also: `git push -u` printed an error because the sandbox could not write upstream tracking into `.git/config`. The push itself succeeded, and the crew had to confirm it with `git ls-remote`.

Ruling: crews get no database and no Docker, and CI is the authority for the full suite. The local duty is what the sandbox can run for the change. A test that a missing service keeps from running is no crew failure. A test that ran and failed, or the crew's own new or changed test failing, still is.

Scenario E (`scenarios/crew-E-brief.md` with the 0.6.4 wording, `scenarios/crew-E-run.md` with the sandbox output). E1: the crate is green and only database tests fail. E2: the same, plus one assertion failing in the changed crate. A fresh agent (sonnet), written answers, with the 0.6.4 skill and brief:

- E1: `status: failed`, `tests_run: 2112`: "I am not reporting the 41 from the subset as `tests_run`, so the status is `failed`". It reproduces the real run. It noticed the push error and checked it with `git ls-remote` on its own initiative.
- E2: `failed`, correct. It also gave "the full command stays red on `DATABASE_URL`" as a reason for failing, so it could not tell the two kinds of failure apart.

Misses the skill targets: the scope of the local test duty, a way to report a test that a missing service kept from running, and the line between that and a test that failed. The brief carries the same rule (`writeBrief`), so both change together.

### With skill (GREEN), 0.6.5

Run on 2026-11-03 (sonnet), `scenarios/crew-E-brief2.md` (the new brief wording) and the updated skill, same sandbox output:

- E1: `status: done`, `tests_run: 742`, `not_run_here` with `cargo test --workspace`, `missing: database` and the error line as reason. It pushed without `-u`, checked `git ls-remote` against `git rev-parse HEAD`, and called the `.git/config` error harmless once the two matched.
- E2: `status: failed`, not pushed: "Because one failure is not a missing service, the run counts as failed. I did not leave the failing test out to get a green count."

## One `gh pr create` form: baseline (RED), 0.6.6

An independent review of 0.6.6 found the guard's reading of `gh pr create` flags differed from gh's own parser (short groups, `=`, aliases, `--recover`, `--template`, `--body-file -`). Ruling: one form only, `gh pr create --head studio/<id> --base <branch> --title <text> --body-file <relative file>`. The baseline is deterministic, so it is a test, not an agent run: `test/guard.test.ts` ("the crew skill and brief name the one gh pr create form the guard allows") fills in the skill's and the brief's command and asks the new guard. With the 0.6.5 wording, `gh pr create --head studio/<id> --title "<id>: <summary>" --body-file <file>`, both were denied (no `--base`): a crew following the skill could not open its pull request.

### With skill (GREEN), 0.6.6

The skill and the brief name `gh pr create --head studio/<id> --base main --title "<id>: <summary>" --body-file <file>`, with the file a relative path in the checkout; the same test allows both. Crews branch from `origin/main`, so the base is `main`.

## Review on running CI: baseline (RED), 0.6.7

Recorded from a real run on 2026-11-03 (Studio 0.6.6), anonymised. A reviewer crew was launched while the pull request's CI was still running. Its analyzers found nothing wrong with the code, yet it returned `changes_requested`, giving the running CI as the only reason. That forced a fix round with nothing to fix.

Scenario F (`scenarios/review-F-run.md` with `scenarios/review-F-routine.md`, the 0.6.6 routine): code fine, both analyzers pass, the probe went red, `checks.txt` shows `e2e: pending`. A fresh agent (sonnet), written answer: `verdict: pending`, a value the report schema does not have, "I won't approve until e2e finishes green". `collect` would refuse that report. A crew held to the schema has only `changes_requested` left, as in the real run.

Misses the routine targets: what to answer when the code is fine, and that running checks are no finding. The launch side changes too: a review now waits (`ci pending`) until the checks have completed.

### With the new routine (GREEN), 0.6.7

Same scenario with `scenarios/review-F-routine2.md` (the 0.6.7 routine, one added rule), sonnet: `verdict: approve`, "the e2e check is still running, which is not a reason for `changes_requested`, so I approve and Studio holds the approval until the checks pass."
