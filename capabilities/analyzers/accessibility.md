# Accessibility review (UI items)

**Question:** Can someone who uses a keyboard, a screen reader, zoom, or who cannot tell colours
apart, do everything this change lets others do?

Scope: the UI files changed in the item and the components they render.

## Checks

1. **Names and roles.** Every interactive element has an accessible name (visible label,
   `aria-label` or `aria-labelledby`); icon-only buttons included. Native elements (`button`, `a`,
   `input`) instead of clickable `div`s; if not native, the right role and key handling.
2. **Keyboard.** Everything reachable and operable by keyboard, in a sensible order; visible focus;
   no keyboard traps; dialogs move focus in and give it back on close; `Escape` closes.
3. **Forms.** Labels bound to inputs; errors announced and linked to the field
   (`aria-describedby`); required fields marked in text, not only by colour; input types and
   `autocomplete` set.
4. **Contrast and colour.** Text at least 4.5:1 (3:1 for large text and UI parts) in every theme the
   project has, including dark mode; state never conveyed by colour alone.
5. **Dynamic content.** Loading, empty and error states announced (`aria-live` or focus); content
   that appears or changes without focus movement is not missed by screen readers.
6. **Zoom and motion.** Layout works at 200 % zoom and narrow widths without horizontal scrolling
   of text; animations respect `prefers-reduced-motion`.
7. **Media and images.** Meaningful images have alt text; decorative ones are marked as such.
8. **Target size.** Interactive targets are at least 24×24 CSS px (WCAG 2.2 SC 2.5.8, AA) —
   anything smaller is a finding. On touch devices, a target between 24×24 and 44×44 is a note,
   not a finding; the 44×44 figure is a recommendation, not the AA line.

## Platform checklists

Read only the `## Checklist` section of the matching `design/platform-web.md`,
`design/platform-apple.md` or `design/platform-android.md` — not the rest of the file. If the
project targets several platforms, read only the checklists of the platforms the changed files
belong to.

## Platform notes

- **SwiftUI:** `accessibilityLabel`, `accessibilityHint`, grouping with `accessibilityElement`;
  Dynamic Type. Apple's own guidance recommends hit areas of at least 44×44 pt — keep this as a
  platform recommendation (note), not the AA finding threshold, which is 24×24.
- **Web frameworks:** component libraries often get roles right and names wrong — check the
  rendered output, not the component call.

## Critical when

A task cannot be completed with keyboard or screen reader, or information is only available by
colour. Everything else is a note.
