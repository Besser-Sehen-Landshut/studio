# Spec check

**Question:** Does this change meet every requirement of the item — no more, no less — and does a
test prove each one?

The requirement is the item's Definition of Done (DoD). If the item has no DoD, there is nothing to
check: return `Result: skipped: no DoD`. Dispatch this check in a throwaway copy of the
checkout inside the crew's tmp dir, because breaking code in the shared tree would mislead other
analyzers. The reviewer removes the copy when done.

Besides the contract: the diff as a file (including untracked files) and the DoD. Never the
builder's reasoning.

## Procedure

1. Number the DoD criteria in order: C1, C2, ...
2. Return a verdict table first, one row per criterion:

```markdown
| Criterion | Verdict                  | Evidence               |
| --------- | ------------------------ | ---------------------- |
| C1        | met / not met / untested | test name or file:line |
```

3. Then the findings, each with a quote of the requirement:
   - **(a)** required but missing or partial — critical
   - **(b)** implemented but not required — note
   - **(c)** implemented but probably wrong — critical
   - **(d)** criterion without a test — critical

   For each (d), write the test and **see it red once**: break the checked code, the test goes
   red, restore, the test goes green. Return the test as a patch with that evidence.

Simplicity never removes a requirement: a dropped criterion, error handling, trust-boundary
validation, or security or data-integrity behaviour is critical.

## Mutation probe

The mutation probe runs in the large tier only; the verdict table stays in both tiers. Pick at most 2 criteria that are security-
or contract-critical and `met` by an existing test. For each:

1. Name the test that is supposed to guard the criterion.
2. In the throwaway copy, break the guarding line (comment it out, negate it, change a default
   value).
3. Run only that test.
4. Restore the line.

Outcomes:

- **Still green** — critical: the test cannot fail, so the criterion is not really guarded.
- **No named red test** — the probe is invalid, not passed: the criterion counts as untested.
- Red — the guard works; record the test.

## Output

The contract format, analyzer name `Spec check`: the verdict table, then the findings table. The
`Result:` line is followed by one more line for the report's `mutation_probe` field:

- `mutation_probe: red: <test>` when the probe ran and the named test went red;
- `mutation_probe: skipped: <reason>` when it did not run (small tier, no criterion qualified, no
  runnable test).
