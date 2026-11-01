# States: loading, empty, error

Every view that shows data has more than one state. Design all of them before
calling a screen done; the happy path is the state people see least on their
first visit. This file is the single home for empty states. Error message
wording follows `ux-writing.md#error-messages`; field-level validation lives
in `forms.md`.

## The state set

For each data-driven view, define and render:

| State | Shown when |
|---|---|
| Loading (first) | nothing to show yet |
| Loading (refresh) | old data exists, new data on the way |
| Empty | request succeeded, there is nothing |
| No results | a filter or search excluded everything |
| Partial | some parts loaded, others failed |
| Error | the request failed |
| Offline | no connection; show what is cached |
| No permission | the person may not see or do this |
| Success | content, the normal case |

A screen that only has "success" plus a spinner is unfinished.

## Loading

- Acknowledge every action at once: pressed state, busy label, or an
  optimistic update. Nothing may look frozen.
- Under about one second, avoid flashing a spinner; delay it briefly so quick
  responses do not flicker.
- For layout-heavy content, prefer a skeleton that matches the final layout so
  nothing jumps when data arrives. Reserve space for images and async blocks.
- Use a determinate progress bar when the duration or size is known (uploads,
  imports); an indeterminate indicator only when it is not.
- On refresh keep the old content visible and mark it as updating; do not wipe
  the screen back to a skeleton.
- Never block the whole app with a modal spinner for work that concerns one
  region. Scope the indicator to the region.
- Announce completion of long operations to assistive technology (on the web a
  polite live region; `aria-busy` on the updating region).

## Empty

The empty state is often a new user's first impression of a feature, so it is
designed, not left over.

- First use: say what will appear here and offer the one action that fills it
  ("Create your first project"). A small preview or illustration is optional,
  never required.
- No results: name the filter or query that caused it and offer a way out
  (clear filters, check spelling, broaden the search).
- Cleared ("all done"): confirm the good news briefly; no call to action is
  needed.
- Never show a bare table header with no rows and no explanation.
- Where comprehension depends on content, sample data is an option, clearly
  labelled and removable in one step (see `onboarding.md`).

## Errors

Prevent first, then detect, then explain, then help recover.

- **Prevent:** constrained inputs, sensible defaults, confirmation or undo for
  destructive actions, auto-save for long input.
- **Detect:** handle network failures, timeouts, expired sessions, and missing
  permissions explicitly; never let them surface as a blank region or an
  endless spinner. Every request has a timeout.
- **Explain:** follow the pattern in `ux-writing.md#error-messages`. No raw
  codes or stack traces in the UI; a short reference ID for support is fine.
- **Recover:** keep the person's input and position; when a failure is likely
  temporary, make trying again easy (automatic retry with backoff for background requests, manual retry
  for user actions); offer an alternative path when retry cannot help.

### Where errors appear

| Scope | Presentation |
|---|---|
| One field | inline under the field (`forms.md`) |
| A form | summary at the top plus inline errors |
| A region or widget | inline message in that region with retry; rest stays usable |
| The whole page | full-page state with retry and a way back |
| Background or network | non-blocking banner or toast with retry; not auto-dismissed if action is needed |
| Permission | name the missing access and who can grant it |

Severity is visible and consistent: error, warning, info, success each have a
distinct colour plus an icon or word, never colour alone.

## Destructive actions

- Prefer undo over confirmation for reversible actions (delete with an undo
  toast for several seconds).
- Use a confirmation dialog only when the action cannot be undone; name the
  object and the consequence, and label the button with the verb ("Delete
  project"), not "OK".

## Offline and partial

- Show cached content with a clear "offline" or "last updated" marker.
- Queue user changes when possible and say so; never drop them silently.
- In a partial failure, render what succeeded and mark only the failed part.

## Checklist

- [ ] Each data view renders loading, empty, error, and success states
- [ ] Every user action gets immediate visible feedback
- [ ] Skeletons or reserved space prevent layout shift on load
- [ ] Refresh keeps existing content visible instead of resetting the view
- [ ] Loading indicators are scoped to the region that is loading
- [ ] Empty states explain the area and offer the next action
- [ ] No-results states name the cause and offer a way to widen the search
- [ ] Every request has a timeout; failures never show an endless spinner
- [ ] Error messages follow the what/why/what-to-do pattern in `ux-writing.md`
- [ ] No raw error codes or stack traces shown to users
- [ ] Input and scroll position survive errors and retries
- [ ] Transient failures offer retry; persistent ones offer an alternative
- [ ] Severity uses colour plus icon or text
- [ ] Reversible deletes offer undo; irreversible ones confirm with a named verb
- [ ] Offline and partial failures show cached or successful parts, marked
