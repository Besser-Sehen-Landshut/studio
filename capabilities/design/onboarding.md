# Onboarding and first run

The first run decides whether someone comes back. The aim is not to teach the
product but to get the person to the first moment where it is useful to them,
with as little in the way as possible. Empty states themselves are specified in
`states.md#empty`; copy rules are in `ux-writing.md#empty-states-and-onboarding-copy`.

## Define the first useful moment

- Name one concrete action or result that shows the product's value (the
  first report generated, the first item synced, the first invoice sent).
- Design the first run as the shortest path to that moment. Anything not
  needed for it is deferred.
- Write the moment down in the item or epic plan so it can be measured later.

## Order of priorities

1. Reach value quickly.
2. Orient, do not lecture: where am I, what can I do next.
3. Give an early success the person caused themselves.
4. Collect only what is needed right now.

## Choose a pattern

| Pattern           | Fits when                                            | Keep in mind                                                              |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Contextual hints  | many features, people learn by doing                 | show a hint once, at the moment the feature becomes relevant; dismissable |
| Setup steps       | the product cannot work without configuration        | as few steps as possible, progress visible, optional steps skippable      |
| Sample content    | an empty product is meaningless (dashboards, boards) | labelled as sample, realistic, removable in one action                    |
| Short guided tour | three to five core concepts                          | skippable at any point, highlights what to do, not everything that exists |

Mixing is fine; a long tour plus a long wizard is not. Avoid tours that start
before the person has any context for them.

## Reduce friction

- Let people try before an account is required where the product allows it.
  Offer single sign-on or passkeys when an account is needed.
- Ask for profile details, preferences, billing, and invitations later, at the
  point where they matter.
- Ship with presets good enough that nobody has to open settings to start.
- Request system permissions (notifications, location, camera) in context,
  right before the feature that needs them, with one sentence explaining why.
  Never batch them at launch.
- Every non-essential step has "skip" or "later", and skipped items resurface
  in the product (a checklist, a settings badge), not as nagging modals.

## Mobile specifics

- Intro screens before the app: at most three, always skippable; better none.
- The launch screen matches the first real screen; no logo splash that delays
  the app.

## Returning users

- Onboarding is not a one-time event: people who skipped it, or come back after
  a long break, need a light way back in (a "getting started" entry point, a
  "what's new" note only for changes that affect them).
- Hints that were dismissed stay dismissed.

## Measure it

- Activation: share of new accounts that reach the first useful moment.
- Time to that moment.
- Drop-off per step of setup.
- Retention after one and four weeks as the downstream signal.

Instrument these when the flow ships, not afterwards. Every larger product
change is also an onboarding change: walk through the first run again,
because nobody else on the team still sees it.

## Checklist

- [ ] The first useful moment is named and the flow leads straight to it
- [ ] The first run asks only for data needed to reach that moment
- [ ] Non-essential steps are skippable and resurface later in the product
- [ ] Tours or hints are dismissable at any point and stay dismissed
- [ ] Setup steps show progress and their total number
- [ ] Sample content, if used, is labelled and removable in one action
- [ ] Permissions are requested in context with a one-line reason
- [ ] Sensible defaults let the product work without visiting settings
- [ ] Mobile intro screens are absent or at most three and skippable
- [ ] Empty states on first run follow `states.md#empty`
- [ ] A way back into onboarding exists for returning users
- [ ] Activation and per-step drop-off are instrumented
