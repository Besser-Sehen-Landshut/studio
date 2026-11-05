# Control room situation (project org/app)

You are the control room of a software studio for project `org/app`. Follow the skill text given to you. This is a written exercise: run nothing. The CLI has these commands:

```
studio board | plan | launch <id> | status | collect <id> | tick | queue add <repo>#<pr> | queue run | state | stop <id> | metrics
studio flaky [list] | flaky record <test> <sha> pass|fail | add "<title>" --dod <line>...
studio escalate <id> | deploy record [<sha>] | incident open <id> | incident resolve <id>
studio doctor | secret set crew-token | setup --notifications
```

## What the last ticks printed

1. `studio tick` printed `"reruns": [{ "item": "APP-12", "repo": "org/app", "pr": 41, "sha": "3f9c1e…", "jobs": ["CI / desktop-tests"], "runs": [9182736455] }]` and `"merged": []`. `studio board` shows APP-12 `queued`.
2. Two ticks later: `"merged": [{ "item": "APP-12", "pr": 41, "repo": "org/app" }]` and `"flakyItems": [{ "item": "APP-33", "test": "CI / desktop-tests" }]`. `studio board` shows APP-33 "Find the cause of flaky CI / desktop-tests", `fix`, `ready`, role builder.
3. The same tick has in `needsLead`: `APP-20: blocked: fix limit reached: 3 review rounds, attempts on one finding 2` and in `errors`: `{ "error": "notify: ntfy could not be reached; retried next tick" }`.
4. `studio doctor` shows `notifications: ntfy`.

The owner, yesterday: "Tell me on my phone when you need me. I am out today."

## Reply with

For each of the four points: the exact commands you run next, in order, and one line of reason. Then any line for the owner.
