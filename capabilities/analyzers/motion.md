# Motion review (items that change animation)

**Question:** Does every animation this change adds or alters earn its place — right frequency,
easing, duration and origin, interruptible, cheap to render, and respectful of reduced motion?

Scope: the changed files that contain a sweep hit, plus the components that trigger those
animations (to judge how often a user sees them).

## Standard

The yardstick is the animation standards file (`review-animations`) of the
[emilkowalski/skills](https://github.com/emilkowalski/skills) repository (MIT). This analyzer reads
fetched sources only: the brief lists the fetched file, and you read it from disk at run time, not
from memory. Nothing is installed or downloaded to run this review.

When the brief lists no such file, or the file is missing, stop and return
`Result: skipped: animation standards not in the brief` — the lead records `skipped: <reason>` as
the evidence, never a pass. Cite the standard's values (curves, durations, frequency table) in
findings instead of approximating them.

## Sweep

Probe the scope for these and judge every hit:

- **CSS:** `transition`, `animation`, `@keyframes`, `will-change`, `transform` inside `:hover` or
  state selectors, `prefers-reduced-motion`.
- **JS/TS animation libraries:** `motion.` (Motion/Framer Motion components), `animate(`,
  `useSpring`/`useTransition`, `gsap.`, `element.animate(`.
- **React Native / Expo:** `withSpring`, `withTiming`, `Animated.`, `LayoutAnimation`.
- **SwiftUI:** `withAnimation`, `.animation(`, `.transition(`.

## Judge each candidate

For each hit, against the standard:

1. **Should it animate at all?** How often does a user see it (frequency table)? Is it triggered by
   the keyboard? A command palette or list navigation that animates is a finding.
2. **Easing and duration.** Enter/exit, on-screen movement, hover and constant motion each have a
   prescribed curve; `ease-in` on UI and durations outside the standard's ranges are findings.
3. **Origin and physics.** Popovers scale from their trigger (modals stay centred); nothing
   scales from 0; springs where the standard asks for them.
4. **Interruption.** Can the user reverse it mid-way (transitions vs. keyframes), does it block
   input while running?
5. **Performance.** Only `transform` and `opacity` animated; no layout properties (`width`,
   `height`, `top`, `left`, `margin`) on frequent motion.
6. **Reduced motion.** Under `prefers-reduced-motion` (or the platform equivalent) movement and
   position changes are removed; transitions that aid comprehension (fades) may stay.

## Critical when

Motion that hides or delays content a user needs (input blocked until an animation ends), large or
looping movement with no reduced-motion alternative, or animation of layout properties on a path
that runs continuously (scroll, drag, list rendering) and visibly janks. Everything else is a note.
