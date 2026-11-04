---
name: add
description: Use when the owner asks in plain words to put work on the Studio board of this project (.studio/board.yaml), outside a crew session.
argument-hint: "[what needs doing, in your words]"
---

# Add work to the Studio board

Request: $ARGUMENTS (when empty, ask the owner what needs doing, in one question).

1. Make one item of it. Ask one question only when you cannot say what done means.
   - Title: one short line in plain words.
   - Type: `fix` when something is broken, `chore` or `docs` when they fit. New behaviour is a
     `feature`, which needs `--plan <file>`; without a plan, add `research` "Plan: <title>" instead.
   - `--path`: the folders it is about, found by looking at the repository, as globs
     (`src/checkout/**`).
   - `--dod`: one to three lines a reviewer can check; for a fix, one of them is a test.
   - `--component`: when `studio.yaml` has components and one fits.
2. Run `studio add "<title>" --type <type> --path <glob> --dod <line> ...`. Never edit
   `board.yaml` yourself.
3. Tell the owner in one or two plain lines: the id, what it is, when it counts as done, and what
   `missing` says the planner still needs.
4. Nothing starts by itself. Say the lead picks it up ("run the Studio lead loop"); do not start the
   loop or a crew unasked.
