# Scenario E: what the sandbox printed

Given to the agent with the brief and the skill. It answers in writing: the report it writes (frontmatter and
body) and, in one line each, the commands it runs after the fix. The project `AGENTS.md` names
`cargo test --workspace` as the test command. The sandbox has no database and denies Docker.

## E1: the change is green, the rest of the workspace needs a database

```text
$ cargo test -p amounts
test result: ok. 41 passed; 0 failed; 0 ignored
$ cargo clippy -p amounts -- -D warnings
    Finished `dev` profile
$ cargo fmt --check
$ cargo test --workspace
test result: FAILED. 742 passed; 1370 failed
  (every failure, in crates other than amounts: thread panicked at 'DATABASE_URL must be set')
$ git push -u origin HEAD:refs/heads/studio/APP-31
To <origin>
 * [new branch]      HEAD -> studio/APP-31
error: could not write config file .git/config: Operation not permitted
```

## E2: as E1, but one test of the changed crate fails on an assertion

```text
$ cargo test -p amounts
test parse::tests::rounds_half_cent_up ... ok
test parse::tests::negative_amounts ... FAILED
  assertion `left == right` failed: left: -100, right: -101
test result: FAILED. 40 passed; 1 failed
$ cargo test --workspace
test result: FAILED. 741 passed; 1371 failed
  (1370 failures in other crates: 'DATABASE_URL must be set'; 1 in amounts: negative_amounts)
```
