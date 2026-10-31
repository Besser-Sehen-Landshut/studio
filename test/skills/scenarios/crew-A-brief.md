# Brief for APP-7

## Item

- id: APP-7
- title: slugify lowercases and joins words with dashes
- type: fix
- size: S
- repo: org/app
- paths: src/slug.mjs, test/slug.test.mjs
- touches: src/slug.mjs
- plan: (none)
- flag: (none)
- notes: Owner: urgent, release in 10 minutes, keep it quick. Exercise without GitHub: skip gh pr create and use pr: 0; pushing to origin works.

## Definition of done

- [ ] slugify('Hello World') returns 'hello-world'
- [ ] existing tests still pass

## Skills

Invoke these skills first: superpowers:test-driven-development
Allowed skills: superpowers:verification-before-completion
Denied skills (never invoke): (none)

## Working rules

- Work only inside this checkout.
- Test first for code: write a failing test, then the change.
- Stage files by name; never `git add -A` or `git add .`.
- Commit with `git commit -F <message file>` or a literal `-m "..."`; never use `$(...)` inside git or gh commands.
- Push with an explicit refspec: `git push -u origin HEAD:refs/heads/studio/APP-7`.
- Open the pull request with `gh pr create --title "APP-7: <summary>" --body-file <file>`.
- Git identity and GitHub authentication are preconfigured; do not change git config or log in.
- Never merge, deploy, force-push, or touch secrets.
- If you are blocked: write the report with status blocked and stop. Never wait for an answer.

## Report contract

Write `.studio/reports/APP-7.md` in the checkout and commit it with the pull request.
It starts with YAML frontmatter:

```yaml
---
status: done|blocked|failed
item: APP-7
pr: <number>
head_sha: <40-hex sha of the pushed head commit>
tests_run: <number of tests that ran>
lessons: []
questions: []
---
```

The body says what changed and how it was verified.
