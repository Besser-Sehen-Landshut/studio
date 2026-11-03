# Brief for APP-31

## Item

- id: APP-31
- title: parse_amount rounds half-cent values up
- type: fix
- size: S
- repo: org/app
- paths: crates/amounts/**
- touches: crates/amounts/src/parse.rs
- plan: (none)
- flag: (none)
- notes: (none)

## Definition of done

- [ ] parse_amount("1.005") returns 101 cents
- [ ] cargo test -p amounts, clippy -D warnings and fmt --check pass

## Skills

Invoke these skills first: studio:studio-crew, superpowers:test-driven-development
Offered skills: superpowers:verification-before-completion
Denied skills (never invoke): (none)

## Working rules

- Work only inside this checkout.
- Test first for code: write a failing test, then the change.
- Stage files by name; never `git add -A` or `git add .`.
- Commit with `git commit -F <message file>` or a literal `-m "..."`; never use `$(...)` inside git or gh commands.
- Push with an explicit refspec and without `-u`: `git push origin HEAD:refs/heads/studio/APP-31`. Check it with `git ls-remote origin refs/heads/studio/APP-31`: its SHA must equal `git rev-parse HEAD`. An error about upstream tracking or `.git/config` after a push that this check confirms is harmless.
- Do not open the pull request, and do not run gh at all: it cannot verify TLS in this sandbox. Give `pr_title: "APP-31: <summary>"` in the report and write the pull request text as the report body; Studio opens the pull request from your pushed branch.
- Git identity and GitHub authentication are preconfigured; do not change git config or log in.
- Never merge, deploy, force-push, or touch secrets.
- Tests: run everything this sandbox can run for what you changed: the tests of the package, crate or workspace member you changed, the tests of the Definition of Done, lint and format. Run the full test command too where it can run here. CI runs the full suite on your pushed branch. tests_run is the count those runs printed.
- A test that ran and failed is a failure, never not_run_here: fix it or report status failed. The same for your own new or changed tests, and for a command that errors for another reason (wrong directory, missing module, red on the unchanged checkout). Never leave out a failing test to get a green count.
- Only a test that cannot run here because a service is missing (a database, Docker, network outside the allowed hosts, another service the tests need) goes into not_run_here, with the command, the missing service and the error line as reason; status done still holds. Crews get no database and no Docker: do not try to start one.
- If you are blocked: write the report with status blocked and stop. Never wait for an answer.

## Report contract

Write `.studio/reports/APP-31.<random>.md` in the checkout as the last step, after pushing; do not commit it. Only that file name counts. head_sha is the SHA of the pushed head (`git rev-parse HEAD`).
It starts with YAML frontmatter:

```yaml
---
status: done|blocked|failed
item: APP-31
pr_title: "APP-31: <summary, one line, at most 200 characters>"
head_sha: <40-hex sha of the pushed head commit>
tests_run: <number of tests that ran>
not_run_here: []   # or entries { command: <command>, missing: database|docker|network|service, reason: <error line> }
lessons: []
questions: []
---
```

The body says what changed and how it was verified.
