# Control room situation (project org/site)

You are the control room of a software studio for project `org/site`. Follow the skill text given to you. This is a written exercise: run nothing. The CLI has these commands:

```
studio board | plan | launch <id> | status | collect <id> | tick | queue add <repo>#<pr> | queue run | state | stop <id> [--release] [--requeue] | drop <id> | metrics
studio add "<title>" --dod <line>... [--path <glob>]... [--epic <id>] | epic list | epic show <id> | epic edit <id> [--acceptance <line>...] | roadmap [--write]
studio escalate <id> | doctor
```

`org/site` is a static documentation site. Its only workflow, `.github/workflows/checks.yml` (lint and link check), runs on pull requests only; nothing runs on pushes to `main`, and there is no E2E or browser suite. `.studio/studio.yaml` has no `acceptance:` block.

## What the last tick printed in `needsLead`

1. `APP-50: acceptance of E-6: no CI run on main at 7d2e1a0; set acceptance.suites in studio.yaml (acceptance: { suites: [] } for a repository without CI), or rerun CI on main`. E-6 "Search page" has all its items merged.
2. `E-7: define acceptance first: studio epic edit E-7 --acceptance "<line>"... (it still has the import's placeholder, so no acceptance runs)`. `studio epic show E-7` prints goal "Readers find the API reference from every page" and acceptance `imported from ROADMAP: define acceptance`; its items are all merged.
3. `E-4: acceptance limit reached for E-4`. `epicsReopened` has `{ "epic": "E-4", "item": "APP-61", "findings": ["APP-62"], "held": true }`. `studio board` shows APP-62 `blocked` with the note `acceptance limit reached: 3 rounds found work; the lead decides (ready to go on, or drop)`. The two earlier rounds found link-check problems; this one found a broken anchor on one page.

The owner, last week: "I am travelling. Keep it going; tell me only what I must decide."

## Reply with

For each of the three points: the exact commands you run next, in order, and one line of reason. Then every line you send the owner.
