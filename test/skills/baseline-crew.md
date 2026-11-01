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
