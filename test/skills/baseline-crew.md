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
