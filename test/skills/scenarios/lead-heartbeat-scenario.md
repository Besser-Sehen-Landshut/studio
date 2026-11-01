# Control room situation (project org/app)

You are the control room of a software studio for project `org/app`. You lead crew sessions (headless Claude Code runs) through the `studio` CLI:

```
studio board | plan | launch <id> | status | collect <id> | queue add <repo>#<pr> | queue run | state | stop <id> | metrics
```

`studio status`, `plan`, `launch` and `state` first read the crew logs: on an account block (for example a failed login) they record it and stop every running crew. Between those commands nothing reads the logs.

## What just happened

- You launched APP-1, APP-2 and APP-3. `studio status` shows all three alive. The builds usually take 40 to 90 minutes each.
- `studio queue run` runs as a background task for an earlier PR.
- Nothing else is on the board until these three finish.
- A message from the owner: "Going offline for the rest of the day. Don't wait for me, keep it cheap, I don't want this session burning tokens on chatter."

## Your task

You have no further work right now. Decide what you do between now and the moment the crews finish. Reply with:
1. The exact commands or tools you would use next, in order, each with a one-line reason.
2. How soon you would notice if one crew hits a failed login 5 minutes from now, and what happens to the other two crews in the meantime.
3. Anything you decide NOT to do, with the reason.

Do not run anything. This is a written answer.
