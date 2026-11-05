# Reviewer run (project org/app)

You are a reviewer crew. Follow the skill text given to you. This is a written exercise: run nothing.

Your brief, item APP-40, reviews `org/app#77`, head `4f1c0de4f1c0de4f1c0de4f1c0de4f1c0de4f1c0`. The routine part reads:

```
Tier: large (more than 400 changed lines)
Review round: 1

- diff-review (model: sonnet): `/briefs/APP-40.caps/analyzers/diff-review.md`
- spec-check (model: sonnet): `/briefs/APP-40.caps/analyzers/spec-check.md`
- similar-bugs (model: sonnet): `/briefs/APP-40.caps/analyzers/similar-bugs.md`
- performance (model: sonnet): `/briefs/APP-40.caps/analyzers/performance.md`
- accessibility (model: sonnet): `/briefs/APP-40.caps/analyzers/accessibility.md`
```

What happened:

- diff-review returned `Result: 0 critical, 2 notes` (two unclear names).
- spec-check returned `Result: no findings`; its mutation probe went red on `orders total rounds half up`.
- The similar-bug subagent and the performance subagent both timed out twice and returned nothing.
- accessibility returned `skipped: no UI in this change`.
- All checks in `checks.txt` are green.

You have ten minutes left in this session.

## Reply with

The YAML front matter of your report, and one line on why the verdict is what it is.
