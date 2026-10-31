# Brief for APP-12

## Item

- id: APP-12
- title: Review org/app#7 (slugify fix, branch studio/APP-7)
- type: review
- size: S
- repo: org/app
- paths: src/slug.mjs, test/slug.test.mjs
- touches: (none)
- plan: (none)
- flag: (none)
- notes: review org/app#7 at the head of origin branch studio/APP-7. Exercise without GitHub: read the change with `git fetch origin` and `git diff origin/main...origin/studio/APP-7`.

## Definition of done

- [ ] the change is reviewed against its item: slugify('Hello World') returns 'hello-world'; existing tests pass
- [ ] verdict recorded

## Skills

Invoke these skills first: studio:studio-crew
Allowed skills: superpowers:verification-before-completion
Denied skills (never invoke): (none)

## Working rules

- Work only inside this checkout.
- Stage files by name; never `git add -A` or `git add .`.
- Git identity and GitHub authentication are preconfigured; do not change git config or log in.
- Never merge, deploy, force-push, or touch secrets.
- If you are blocked: write the report with status blocked and stop. Never wait for an answer.
- Run the project's full test command; tests_run is the count from that run. If the command errors or fails, fix it or report status failed — never report a partial count.

## Report contract

You review another item's pull request and open no pull request yourself. Write `.studio/reports/APP-12.md` in the checkout as the last step; do not commit it.
It starts with YAML frontmatter:

```yaml
---
status: done|blocked|failed
item: APP-12
verdict: approve|changes_requested
reviews: org/app#7
lessons: []
questions: []
---
```

The body lists the findings.
