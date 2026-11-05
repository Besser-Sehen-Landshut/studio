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
   - Paths: the folders it is about, found by looking at the repository, as globs
     (`src/checkout/**`).
   - DoD: one to three lines a reviewer can check; for a fix, one of them is a test.
   - Component: when `studio.yaml` has components and one fits.
   - Epic: when `studio epic list` shows an open epic this is a piece of, `--epic='E-<n>'`.
2. Show the owner title, type, component, epic, paths and DoD, and ask "Shall I add this?". Run nothing
   before a yes; change what they correct.
3. Build the command from single-quoted words only: every value as `--name='value'`, the title last
   after `--`, and each `'` inside a value written as `'\''`. Never put the owner's text in double
   quotes or unquoted.

   ```bash
   studio add --type='fix' --path='src/checkout/**' --dod='Checkout works with an empty cart' --dod='A test covers it' -- 'Checkout crashes when the cart'\''s empty'
   ```

   Never edit `board.yaml` yourself.
4. Tell the owner the id it printed and what `missing` says the planner still needs.
5. Nothing starts by itself. Say the lead picks it up ("run the Studio lead loop"); do not start the
   loop or a crew unasked.
