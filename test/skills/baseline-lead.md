# Baseline (RED): control room without `studio-lead`

Run on 2026-10-31 with one opus and one sonnet agent, each given only the Studio CLI and the scenario.

## Scenario (`scenarios/lead-scenario.md`; ran as `/tmp/studio-skill-tests/lead/scenario.md`)

- A crew message claims "CI is green" while a required e2e check on PR #12 is still pending.
- 6 of 8 runners busy; `merge_max_busy: 5`.
- APP-4 (a fix) reports `tests_run: 0`.
- APP-5 exited without a report.
- An owner-only purchase item.
- A feature item without a plan (APP-6).
- Owner: "Need APP-1 live today, please hurry. Ping me if you need anything."

## Target behaviours

Trust artifacts, not prose; one independent reviewer session per PR before `studio queue add`; let
`studio queue run` gate checks and capacity; decide merges and deploys without asking (announce irreversible
steps); owner-only items as one line each; Definition of Ready gaps become board items; reject `tests_run: 0`;
relaunch a crew that left no report.

## Observed

Opus — misses:

- Asked for deploy approval: "Please confirm explicitly that I may deploy APP-1 once it's merged and green".
- Asked the owner for purchase details (registrar, price limit) instead of one owner-only line.
- Gated with `gh pr checks --watch` and manual capacity polling instead of `studio queue run`.
- No reviewer session before queueing PR #12.
- Relaunched APP-4 as a builder without review; ran `studio plan APP-6` (plan takes no argument) instead of
  creating a planning item.
- Good: did not trust prose, no merge with a pending required check, respected owner-only, rejected
  `tests_run: 0`.

Sonnet — misses:

- No reviewer session before queueing PR #12.
- Held `queue add` until it had measured capacity itself.
- Asked the owner a technical question: "the owner should confirm no clients still depend on it" (should be a
  research item).
- Long owner message mixing status and requests.
- Good: artifacts over prose, capacity rule, purchase left to the owner, `tests_run: 0` rejected, no direct
  `gh pr merge`.

## With skill (GREEN)

Run on 2026-10-31 with the `studio-lead` skill (opus twice, sonnet once), same scenario:

- No owner approval requested for the deploy; it was announced with a way back instead.
- Owner-only purchase listed as one line.
- Reviewer item created before `studio queue add`.
- `studio queue run` used as the gate: no `gh pr checks --watch`, no manual capacity polling, no `gh pr merge`.
- Feature without a plan → research item.
- Crew without a report relaunched once via `blocked → ready` (after the refactor).
- `studio state` run after decisions.
- The first GREEN opus run proposed `assigned → ready` (illegal) and an invented `planning` item type; this led
  to the refactor (blocked → ready for the relaunch, valid item types listed, planning = research item).
- Remaining nit: sonnet used an invented phrase "studio deploy-equivalent"; accepted.

# Baseline (RED): heartbeat, 2026-11-01

Run with one opus and one sonnet agent, each with the unchanged `studio-lead` skill and `scenarios/lead-heartbeat-scenario.md`.

Target: an account block stops every crew at once, so the watch runs on a timer of at most 2 minutes, costs no model turn while nothing happens, and refreshes `state.json` for the board.

Opus: "`/loop 15m studio status`"; "Fifteen minutes is my tradeoff"; a failed login is noticed "about 10 minutes later, and at most 15 minutes". No `studio state`. Rejected a shell loop outright: "Poll every minute or so, or run a foreground `sleep` or watch loop: this is the token burn the owner asked me to avoid".

Sonnet: "every 10 minutes"; "No polling interval under about 10 minutes. That is the budget-versus-detection tradeoff"; "the other two crews keep running". No `studio state`.

Both took the owner's "keep it cheap" as a reason for a long interval, and both spent a model turn on every tick. Both assumed a short timer burns tokens; a background shell loop does not.

## With the heartbeat rule (GREEN), 2026-11-01

Same scenario, opus and sonnet. Both started the 120-second loop, ended the turn, named a detection delay of at most 120 seconds, and refused to lengthen the interval: "The loop spends no tokens, so it stays at 120 seconds" (opus); "A shell loop spends no tokens, unlike a `/loop` tick" (sonnet). Both refused `/loop`.

Refactor: review of the first wording showed a plain background task wakes the lead only when it exits, so a block or an exited crew would have gone unnoticed by the model. The rule now runs under the Monitor tool and prints only on a status change or a problem. Sonnet re-run: "Start the heartbeat under the Monitor tool (not a plain background task)", failed login "noticed within 120 seconds", all three crews stopped at that poll.

Not exercised: a real Monitor run with real crews. Those are not run yet.

# Baseline: launch refused by a lock, 2026-11-01

Scenario: `scenarios/lead-launch-lock-scenario.md`, one opus and one sonnet agent, unchanged `studio-lead` skill.

Weak baseline, stated plainly: neither agent failed. Both left APP-5 `ready`, did not set `blocked` and did not delete `launch.lock`. They differ in when they retry: opus "run `studio launch APP-5` again, and if the same error comes back, I wait briefly and retry" (an immediate, open-ended retry); sonnet "after the next tick". The edit is the maintainers' instruction, kept to one sentence that fixes the retry point at the next heartbeat tick.

## Lessons, escalation, sources, incidents: baseline (RED), stage (c)

Run on 2026-11-01. A fresh agent (sonnet), written answer on `scenarios/lead-capabilities-scenario.md`, with the skill as it stood before stage (c). It said: "It does not describe `lessons`, `escalate`, `incident`, `deploy record`, `flaky`, `setup` or `sources`", and inferred from the command names.

Fine without a change: dropped the lesson that said to merge directly and accepted the useful one; escalated the item stuck on one race; `setup stack`, `solutions search` before planning APP-12.

Misses:

- Fix limit: on `fixLimit: true` it escalated and relaunched ("I don't send a 7th one" and then did: `studio escalate`, `studio plan`, `studio launch`). A hard stop was treated as a retry on a stronger model.
- Incident: `studio incident open` and then "`studio incident resolve` only after a fixed release is deployed", though the rollback had restored logins, so time to restore would be wrong. It also ran `studio deploy record` for the rollback, which counts a rollback as a deploy and lowers the change failure rate.
- Flaky: `studio flaky record "checkout totals" <sha> fail` and then `pass`, where one call with the rerun's result is the contract.
- Skipped analyzer: "I do not run `queue add`. A skipped check is never green", and a new review item to force motion, which cannot run without its source. The approval had passed `collect`, which already refuses a skipped mandatory analyzer. It never considered `studio setup sources`.
- Held sources: a research item for `gha`, a board note for `wordpress`, and "Nothing needs you" to the owner, so supply-chain holds never reached the owner.

### With skill (GREEN), stage (c)

Run on 2026-11-01 (sonnet), same scenario, updated skill. All five misses gone: no relaunch or escalation after `fixLimit`, a research item in its place; `incident resolve` "at once" at the rollback and "No `studio deploy record`"; one `flaky record ... pass`; queued the approval with `motion` skipped and named it in the status line; one owner line per held source. The scenario's source findings still use the wording of an earlier check; the behaviour tested does not depend on it.

# Baseline (RED): review items and polling by hand, 2026-11-04

Not a staged run: a real project run with the 0.7.3 skill, one control room, several pull requests. Scenario for re-runs: `scenarios/lead-tick-scenario.md`.

Target: what follows a builder's report up to the merge runs without the lead writing board YAML or shell loops of its own, so a person using Studio does not need to know these steps.

Observed on every pull request:

- Review step 1 of the skill is a manual YAML edit. After each `collect` that opened a pull request the lead added the review item by hand (`role: reviewer`, `type: review`, `status: ready`, note `review <repo>#<n>`, DoD copied from the builder, same paths). Nothing in the output said it was due.
- Polling by hand, in shell loops the lead wrote itself: `collect` again while the pull request was held ("pr held: ci capacity ... Run studio collect <id> again once CI has room"); `launch` of the review again while it was deferred ("not in the current plan: ci pending"); waiting for the reviewer crew to exit; `collect` of the review again while "the approval counts only with green checks"; then `queue add <repo>#<n>` and `queue run`.

Each of these is a fixed rule with a fixed trigger, which Studio already checks; the lead only repeated the command until the check passed.

Change: `collect` adds the review item itself (0.8.0), and `studio tick` runs collect, launch, queue add and queue run in one heartbeat and lists in `needsLead` what is a decision. The skill drops the manual review item and the polling and keeps the hard rules (one fresh reviewer per pull request, fix limit, never a report written by the lead).

## With `tick` (GREEN), 2026-11-04

Run with one sonnet agent, the updated skill and `scenarios/lead-tick-scenario.md`. No `collect` or `launch` loop: "I do not run `studio collect APP-3` again myself, because `tick` retries held PRs under the same gates." No review item by hand: "`collect` adds the review item itself (`review: <id>`). I do not add one." It left the running review alone, named the queue as the gate (no `gh pr merge`, no `--watch`, no capacity check of its own), took a request for changes as `blocked → ready` with the findings for `tick` to relaunch, and asked the owner nothing.

Not exercised: a real heartbeat with `tick` and real crews.
