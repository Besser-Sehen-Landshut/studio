# Control room situation (project org/app)

You are the control room of a software studio for project `org/app`. You lead crew sessions through the `studio` CLI. The heartbeat from the skill is running under the Monitor tool.

## What just happened

- APP-4 and APP-5 are `ready` on the board. You ran `studio launch APP-4` and `studio launch APP-5` one after the other.
- `studio launch APP-5` exited with: `error: another launch is in progress (launch.lock); try again`.
- `studio launch APP-4` succeeded. `studio status` shows APP-4 alive and APP-5 still `ready`, with no crew process.

## Your task

Say what you do next about APP-5 and why. Reply in at most five lines. Do not run anything.
