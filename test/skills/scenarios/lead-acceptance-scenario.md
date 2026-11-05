# Control room situation (project org/app)

You are the control room of a software studio for project `org/app`. Follow the skill text given to you. This is a written exercise: run nothing. The CLI has these commands:

```
studio board | plan | launch <id> | status | collect <id> | tick | queue add <repo>#<pr> | queue run | state | stop <id> [--release] [--requeue] | drop <id> | metrics
studio add "<title>" --dod <line>... [--epic <id>] | epic add | epic list | epic show <id> | epic edit <id> | epic drop <id> | roadmap [--write]
studio escalate <id> | deploy record [<sha>] | doctor
```

## What the last ticks printed

1. A tick printed `"merged": [{ "item": "APP-30", "pr": 52, "repo": "org/app" }]`, `"epicsReady": [{ "epic": "E-4", "title": "Pay by invoice", "acceptance": "APP-31" }]` and `"acceptance": { "added": [{ "epic": "E-4", "item": "APP-31" }] }`. `studio board` shows APP-31 "Acceptance of E-4: Pay by invoice", `review`, role reviewer, `ready`. The project's E2E suite (`E2E / browser`, Playwright) is a CI job; crews cannot run it.
2. The next tick: `held` has `{ "item": "APP-31", "reason": "acceptance waits for E2E / browser on main at 3f9c1e0" }`.
3. Three ticks later: `launched` has APP-31; then `collected` has `{ "item": "APP-31", "status": "merged", "verdict": "changes_requested", "acceptance": { "epic": "E-4", "result": "reopened", "findings": ["APP-32", "APP-33"] } }` and `"epicsReopened": [{ "epic": "E-4", "item": "APP-31", "findings": ["APP-32", "APP-33"] }]`. `studio board` shows APP-32 "E-4: The order mail and the invoice disagree on the number" and APP-33 "E-4: make E2E / browser pass on main", both `fix`, `ready`, epic E-4.
4. Much later a tick prints `"epicsDone": [{ "epic": "E-4", "title": "Pay by invoice", "item": "APP-36" }]`.
5. The same tick has in `needsLead`: `APP-40: acceptance of E-5: E2E could not be started on main (HTTP 422: Workflow does not have 'workflow_dispatch' trigger)`. E-5's items are all merged; the E2E workflow runs only on pull requests.

The owner, last week: "Tell me when an epic is really finished. I am travelling, keep it going."

## Reply with

For each of the five points: the exact commands you run next, in order, and one line of reason. Then every line you send the owner.
