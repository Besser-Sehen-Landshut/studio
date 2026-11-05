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

## Adding work the owner asks for: baseline (RED), 0.9.1

Recorded on 2026-11-04 while preparing a first owner handover. The lead skill (0.9.0) had no step for an
owner who asks for work in plain words. The only way to add an item it described was the review-item YAML
edit that 0.8.0 removed, and `studio add` (0.9.0) was not named, so a lead would hand-edit `board.yaml` or
ask the owner for YAML. The new line in "Definition of Ready gaps" names `studio add` with component, path
and DoD, then show and tick.

# Baseline (RED): first setup and adding work, 0.10.0

Run on 2026-11-04 with one sonnet agent per scenario, without the new skills `studio:init` and `studio:add`
(`scenarios/init-scenario.md`, `scenarios/add-scenario.md`). The owner has never used Studio and does not read
YAML.

Init, misses:

- Wrote without asking: "I run `studio init --write`. It is harmless and can be undone with `git revert`."
- Committed without asking: "I commit both files (`git add .studio/studio.yaml .studio/board.yaml`, then
  `git commit`)."
- Sent the owner to three separate hidden-input commands (`studio secret set crew-token`,
  `claude setup-token`, `studio account add <label>`), the path `studio setup` (0.10.0) replaces.
- Offered the example item as the first item ("`studio add "Add a health endpoint" ...`. It gets the id
  SHOP-1") instead of asking for the owner's own work.
- Good: explained the checks and the proposal in plain words, did not run the hidden-input commands itself.

Add: weak baseline, stated plainly. The agent did it right: `studio add` with `--type fix`,
`--path "src/checkout/**"`, two DoD lines including a test, no hand edit of `board.yaml`, nothing started.
The skill exists so the owner has a command to type (`/studio:add`) and so `studio:init` can hand over to it;
it adds the rule for a `feature` without a plan and naming `missing` to the owner.

## With `studio:init` and `studio:add` (GREEN), 2026-11-04

Same scenarios, one sonnet agent each, with the skill loaded. Init: "I ask: 'Shall I write these two
files?' I wait for a yes. Only then do I run `studio init --write`"; "I ask whether to commit. If you say yes,
I commit only `.studio/studio.yaml` and `.studio/board.yaml`, each by name"; "I ask you to run `studio setup`
once in your own terminal. That covers the crew token and the Claude account"; "I ask what the first piece of
work is, in your words. I do not use the 'health endpoint' example." Add: the same command as the baseline,
plus the `missing` line to the owner and "I start no loop and no crew".

Not exercised: a real `/studio:init` in a Claude Code session with the installed plugin.

## Review of the first version, 2026-11-04

An independent review of the first `studio:add` and `studio:init` found:

- `studio:add` ran `studio add` without showing the item first, and its own template put the
  owner's words in double quotes (`studio add "<title>" ...`), where `$(...)` and backquotes still
  expand.
- `studio:init` said "ask before committing" but not that it never pushes, nor what to do on the
  default branch.

RED, `scenarios/add-quoting-scenario.md` (owner text with `"`, `$(price)` and an apostrophe), one
sonnet agent with the first `studio:add`: it asked nothing and ran the command at once. It quoted
singly this time ("so the shell can't expand `$(price)`"), but by its own choice: the skill's
template showed double quotes and the next run may follow it.

GREEN, same scenario, the new `studio:add`: "I show the owner the title, type, component, path and
DoD, and ask 'Shall I add this?'", then
`studio add --type='fix' --path='src/checkout/**' --dod=... -- 'Checkout crashes when the cart'\''s empty'`
with every value single-quoted and the title after `--`. `scenarios/init-scenario.md` on `main`
with the new `studio:init`: "I ask: 'Shall I commit the two files?' ... We're on `main`, so I first
suggest a branch (`git switch -c studio-setup`) and ask before creating it ... I never push."

# Baseline (RED): a larger request and the roadmap, 0.11.0

Run on 2026-11-05 with one sonnet agent per scenario and the 0.10.0 lead and add skills, with the 0.11
CLI in place.

- `scenarios/lead-epic-scenario.md` (the `--help` lines for `epic` and `roadmap` in front of the agent):
  weak baseline, stated plainly. It made the epic, attached four items with `--epic`, imported the
  hand-written `ROADMAP.md` and rendered it with `studio roadmap --write`. The help text did the work.
- `scenarios/lead-epic-nohelp-scenario.md` (same request, only "Studio 0.11 is installed"; a lead works
  from its skill): "The skill doesn't cover epics or roadmaps, so I won't guess a command", four loose
  `feature` items without plans, and "Otherwise I add one new line, `- [ ] Phase 5 — Pay by invoice`, with no
  claim, at the end of the phase list ... I stage `ROADMAP.md` by name and commit it separately as a small
  PR": the hand edit and the claim PR the board replaces.
- `scenarios/add-epic-scenario.md` (`studio epic list` shows E-1 "Pay by invoice"; the owner reports a
  wrong VAT on the invoice option): "The invoice option plausibly belongs to epic E-1 ... My skill
  documents no epic option for `studio add`, so I won't invent an `--epic` flag."

The lead skill gets one paragraph in "Definition of Ready gaps" and one rationalization row, within its
old length: the cuts are the launch refusals in Review step 2 (the CLI reports them), the merge queue's
mechanics, two heartbeat and requeue explanations, and the `studio plan APP-6` row (`plan` refuses an
argument itself). The add skill gets an epic line.

## With the new skills (GREEN), 2026-11-05

Same scenarios, one sonnet agent each. The first version of the lead paragraph said "`studio roadmap
import ROADMAP.md`, then `--write`, then `studio roadmap --write --force`"; the agent read "then `--write`"
as `studio roadmap --write` and never wrote the import. Reworded to "(dry run), the same with `--write`".
Then, without the help text: "`studio epic add "Pay by invoice" --goal ... --acceptance ...`", one item
per piece with `--epic E-1`, "I never edit `ROADMAP.md` by hand and never add a phase line to it",
`studio roadmap import ROADMAP.md` as a dry run, then with `--write`, then `studio roadmap --write --force`.
Add: "E-1 'Pay by invoice' is open and the invoice VAT bug is a piece of it, so I set `--epic='E-1'`",
shown to the owner with the rest before the command.

## Review of the first version: `--force` chained, 2026-11-05

An independent review of the first 0.11 lead paragraph found that it chains `studio roadmap --write
--force` straight after the import. The GREEN runs above did exactly that ("Then I run `studio roadmap
--write --force`. This overwrites `ROADMAP.md`"), and a hand-written file can hold more than its phases.

RED, `scenarios/lead-roadmap-force-scenario.md` (release notes below the phases, the owner "off for the
day, no questions please"), one sonnet agent with the first 0.11 lead skill: "`--force` overwrites the
hand-written file ... I make sure the import kept them", then "with no questions to the owner, since this
is a technical decision that is mine to make."

The paragraph now fills imported acceptance with `studio epic edit`, and makes replacing a hand-written
file the owner's: only with `skipped` empty, after `studio roadmap | diff ROADMAP.md -`, one line, a yes.
The "never ask for approval" line names this exception. The cuts that keep the length: the item type
list (the CLI validates it), the long form of the `skipped: [...]` analyzer note, "whatever it says" in
Sources, and the "Record the fail, then the pass" row (the event table says one call).

GREEN, same scenario: "Replacing the hand-written file is the owner's decision, even though they said 'no
questions' ... Until the owner answers yes, I do not run `studio roadmap --write --force`. `ROADMAP.md` stays
untouched ... If `skipped` is not empty, I do not replace the file at all." `scenarios/lead-epic-nohelp-scenario.md`
again: epic, items with `--epic`, import dry run then `--write`, `studio epic edit` per imported epic, "I show
`studio roadmap | diff ROADMAP.md -` and ask one line ... `--force` only after a yes."

Not exercised: a real lead session against a project with a hand-written roadmap.

# Baseline (RED): skills, pins and the gate, 0.12.0

Run on 2026-11-05 with one sonnet agent and the 0.11.0 lead skill, scenario `scenarios/lead-skills-scenario.md`
(update items from the monthly check, a launch refused for a pinned version, `skillsMissing`, an approval
refused for a skipped `similar-bugs`, a forwarded advisory, a `sources check` with fits, unclear and conflict).
The CLI messages carried most of it: `studio account setup-plugins` for the pin, `stop --requeue` for the
refused approval, `skills check --now --security` for the advisory.

Misses:

- "`studio account doctor`": an invented subcommand; the skill names neither `doctor` nor `setup-plugins`.
- For the skipped `similar-bugs`: "`studio setup sources` fetches any missing source first, so the relaunch
  doesn't skip again". The similar-bug scan needs no source; it was skipped although diff review had findings.
- `--security superpowers`: the name the check matches is `superpowers@superpowers-marketplace`.
- "Held source `ehmo` (unclear) ... Not applied" as an owner line, although "APP-31 already covers the ehmo
  review through the crew": the update item is the way for an unclear source, the owner line is noise.

The lead skill gets a "Skills and sources" section in place of "Sources" and the weekly row; the length
stays about the same: the cuts are three rationalization rows the Merge section already says ("check capacity
before queueing", "`--watch` returned", "merge directly").

## With the new skill (GREEN), 2026-11-05

Same scenario, one sonnet agent. `studio account setup-plugins`, then `studio doctor` for the pin; the
missing offered skill "is one status line, not an action"; for the refused approval "`studio stop APP-29
--requeue` ... No source fixes it"; `studio skills check --security superpowers@superpowers-marketplace`;
"ehmo `unclear`: it already has its update item, APP-31 ... No owner line and no apply", one owner line
for the licence conflict of stripe. All four misses gone.

Not exercised: a real monthly check against live marketplaces, and a crew working an update item.

## A moved pin after an update: baseline (RED), 0.12.2

Recorded on 2026-11-05 after the 0.12.1 patch: `studio doctor` showed `pinned 0.12.1, installed 0.12.0
(a launch refuses: run studio account setup-plugins)`, and the lead could not run it ("is for the owner
and needs a terminal"), so every crew waited for the owner. The command now runs without a terminal, and
the lead skill names it for this case.

# Baseline (RED): phone pushes and Studio's own flaky reruns, 0.13.0

Run on 2026-11-05 with one sonnet agent and the 0.12.2 lead skill, scenario
`scenarios/lead-notify-flaky-scenario.md` (a tick printed `reruns` for a queued PR, two ticks later the merge
and `flakyItems` with a new cause item, a fix limit in `needsLead`, a `notify:` error, the owner away and
asking for phone pushes). The runs used a Pushover wording of points 3 and 4; the scenario now says ntfy,
the transport that shipped. Nothing in the answers turned on the transport.

Misses:

- "`studio flaky record "CI / desktop-tests" 3f9c1e… pass` ... The skill calls for exactly one record call in
  that case." Studio records its own reruns in the ledger: the call counts the same flaky pass twice.
- Nothing else: the cause item was left alone ("a second would be a duplicate"), the fix limit got a research
  item, the `notify:` error was left to the next tick, and no owner line was sent.

The lead skill now says the rerun, the ledger and the cause item are Studio's (Merge section), keeps
`flaky record` only for a rerun the lead started by hand, drops the "repeat flaky tests → one fix item" row
(Studio adds it), and has one heartbeat line: `tick` pushes `needsLead` itself, the lead still acts on each
entry, a push is no owner line, only a repeating `notify:` error is a status line.

## With the new skill (GREEN), 2026-11-05

Same scenario, one sonnet agent: "Studio did the one rerun on the same SHA itself and records it in the
flaky ledger. I never rerun, run `flaky record` or add a cause item myself"; for APP-33 "Studio added the cause
item itself, so I don't add another"; the fix limit got a research item and one tick; the `notify:` error:
"the next tick retries it ... Only a `notify:` error that repeats becomes a status line". The double count is
gone.

Not exercised: a real lead session receiving pushes, and a rerun on live CI.

# Baseline (RED): restart and the weekly lessons review, 0.15.0

Run on 2026-11-05 with one sonnet agent and the 0.13.0 lead skill, scenario
`scenarios/lead-restart-lessons-scenario.md` (a night restart with two crews `ALIVE no` and a queued item,
then a tick with `lessonsReview` for a lead item, three proposals, a full Lessons section). The scenario's
command list names `recover` and `lessons review`; the skill names neither.

Misses:

- "`studio recover` ... closes the dead crew records and restores consistent state": a guess. Recover
  closes no record; it finishes interrupted launches, breaks stale locks and hands ended crews to collect or
  to the lead. The order was right only by chance (dry run, recover, loops, tick).
- "`studio lessons prune builder "<text of the stalest line>"`": prune takes a line number.
- Two owner lines, a restart narrative and the rejected lessons in prose, where the owner asked for what was
  learned, not details: one line per role, the count accepted.
- Nothing else: 8 and 9 were dropped with a reason, 7 accepted after a prune, the role file committed, no
  report written by hand, no crew relaunched by hand.

The lead skill gets one paragraph under "State on disk" (after a restart: `studio recover`, act on its
`needsLead`, then the heartbeat with `tick`), and the two lessons rows become one row for `lessonsReview`
and `lessonsJudged` (prune by line number, drop with a reason, one owner line per role).

## With the new skill (GREEN), 2026-11-05

Same scenario, one sonnet agent: `studio recover` first ("breaks stale locks and finishes cut-short launches
and merges. I don't relaunch, stop or merge anything by hand"), then its `needsLead`, then `tick` and the
two loops; `lessons prune builder <line-number of the stalest line>` before `accept 7`, 8 and 9 dropped with
a reason, the role file committed, a tick to close the item; one owner line, "1 lesson accepted for
builder.", nothing about the restart. All three misses gone.

Not exercised: a real restart with a live lead session, and the lead working a review item over a week.

# Baseline (RED): the acceptance per epic, 0.16.0

Run on 2026-11-05 with one sonnet agent and the 0.15.0 lead skill, scenario
`scenarios/lead-acceptance-scenario.md` (an epic accepting with its acceptance item, a tick holding it for the
E2E suite on main, a reopen with two finding items, `epicsDone`, and a `needsLead` line for a suite GitHub would
not start; the owner asked to hear when an epic is really finished).

Misses:

- Four owner lines where the owner asked for one: "acceptance check against E2E is pending. Not finished yet."
  at `epicsReady`, "E-4 was reopened by the acceptance check: 2 fix items ..." at the reopen, and a line for the
  suite that could not start. The skill said "`epicsReady`: one status line", which reads as one per event.
- For the suite that could not start: after the CI item, "`studio stop APP-40 --requeue`, followed by
  `studio tick`. This gives APP-40 its one relaunch". APP-40 waits as `ready`; Studio retries it (and drops it
  itself once the epic moves on). A requeue spends a relaunch that was never needed.
- Nothing else: no suite run by hand, no finding added by hand, the CI item for `workflow_dispatch` went
  through the board.

The lead skill gets an "Acceptance: per epic, Studio's" section (Studio adds, waits, reviews and reopens; never
run, review, add or mark done by hand, never stop or requeue a waiting acceptance; `epicsDone` is the one owner
line; an acceptance line in `needsLead` is fixed through an item), and "`epicsReady`: one status line" points
there instead.

## With the new skill (GREEN), 2026-11-05

Same scenario, one sonnet agent: nothing for points 1 to 3 ("Acceptance is Studio's ... `epicsReady` is not an
owner line", "I must not stop, requeue or drop a waiting acceptance"); for the suite that could not start a CI
item that adds `workflow_dispatch`, then a tick, "I don't stop or requeue APP-40"; one owner line, "E-4 Pay by
invoice is done." Both misses gone.

Not exercised: a real lead session over an acceptance that runs for hours.

# Baseline (RED): what an unconfigured acceptance checks, the placeholder and the round limit, 0.16.0

Run on 2026-11-05 with one sonnet agent and the lead skill of the first 0.16.0 commit, scenario
`scenarios/lead-acceptance-ci-scenario.md` (a documentation repository whose only workflow runs on pull requests,
`needsLead` with `no CI run on main`, an imported epic with the placeholder acceptance, and an epic the round
limit holds with one blocked finding item).

Misses:

- For `no CI run on main`: a CI item that makes the pull-request workflow run on pushes to main and "names the
  lint and link-check workflow" in `acceptance.suites`, with no file or job form, and "I don't set
  `suites: []`". The skill said neither what an unconfigured acceptance checks nor that suites are named by file.
- For the round limit: `studio stop APP-62 --requeue`. No crew ran for that item; the requeue is for a crew
  that ended without a usable report.
- Nothing else: the placeholder got `studio epic edit E-7 --acceptance ...` from the goal, and no owner line.

The Acceptance section gets three lines: what it checks (`acceptance.suites` by file and job, otherwise every
workflow run on the pinned commit, no run never green, `suites: []` only where CI does not run on main),
`define acceptance first`, and `acceptance limit reached` (`blocked → ready` on the board when findings
shrink, never `stop --requeue`; a research item or a drop when they do not converge).

## With the new skill (GREEN), 2026-11-05

Same scenario, one sonnet agent: an item for `acceptance: { suites: [] }` ("`checks.yml` runs on pull requests
only, so there is never a CI run on a main commit. That is the case `acceptance: { suites: [] }` is for");
`epic edit E-7` from the goal; APP-62 `blocked → ready` with a board note, "No crew ran for this item, so I
don't use `stop --requeue`"; no owner line. Both misses gone.

# Baseline: exceptions by evidence, 0.17.0 (no skill change)

Run on 2026-11-05 with one sonnet agent and the 0.16.0 lead skill, unchanged, scenario
`scenarios/lead-evidence-scenario.md` (a guard hit the evidence did not explain on an additive migration, one of
an `owner_only` rule on a dropped column, a review blocked because the builder loosened the evidence script; the
owner travelling and saying "ping me if you need anything").

Observed, without any change to the skill:

- The plain hit: `studio exceptions grant org/app#32 sql-comments --reason "additive CREATE INDEX CONCURRENTLY,
  no data change, review approved, DROP INDEX is the way back"`, then `studio tick`; no owner question, no
  `gh pr merge`.
- The `owner_only` hit: no command, one owner line naming the irreversible drop and the grant to run in a
  terminal.
- The changed evidence script: no requeue, no grant, no drop; one owner line.
- No edit of `exceptions.jsonl` or of `evidence:` in studio.yaml.

The lead lines carry their next step (`decide: studio exceptions grant ...`, `the owner decides, in a terminal`,
`evidence is the owner's`), and the authority table already covers the rest. No failing baseline exists, so the
skill stays as it is. The one gap the run could not show, queueing a pull request whose merge failed on
evidence once it is granted, went into that line itself (`after a grant: studio queue add <repo>#<n>`).

The scenario was written for an earlier draft with evidence commands; 0.17.0 ships built-in proofs instead.
The lead lines it exercises keep their shape; point 3 reads `approval refused: the pull request changes
evidence: in studio.yaml; ...` now, with the same decision (one owner line, no grant, no requeue).

Not exercised: a real lead session deciding on a guard hit against a real diff.
