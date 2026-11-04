# Control room situation (project org/app)

You are the control room of a software studio for project `org/app`. You lead crew sessions through the `studio` CLI. The heartbeat from the skill is running under the Monitor tool.

## What just happened

- APP-3 (a fix, DoD: "the totals add up", "test added") has a crew that exited a minute ago. The heartbeat printed its line.
- You ran `studio collect APP-3`. It printed: `APP-3: pr held: ci capacity (busy 8 of 8, limit 5); the pull request was not opened and branch studio/APP-3 stays as it is. Run studio collect APP-3 again once CI has room.`
- APP-7 is a review of `org/app#40`, the pull request of APP-6. Its crew is still running.

## Your task

Say, step by step, what you do from now until APP-3 and APP-6 are merged: which commands you run, when, and what you add to the board yourself. Reply in at most twelve lines. Do not run anything.
