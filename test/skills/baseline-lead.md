# Baseline (RED): control room without `studio-lead`

Run on 2026-10-31 with one opus and one sonnet agent, each given only the Studio CLI and the scenario.

## Scenario (`/tmp/studio-skill-tests/lead/scenario.md`)

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
- Remaining nit: sonnet used an invented phrase "studio deploy-equivalent"; accepted.
