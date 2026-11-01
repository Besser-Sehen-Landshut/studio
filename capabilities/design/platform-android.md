# Platform: Android

Source: see ../NOTICE.md (condensed and rephrased from ehmo/platform-design-skills, MIT).

Material Design 3 and Android platform rules an implementer or reviewer needs
most often, for Jetpack Compose and View-based apps.

## Theming and colour

- Dynamic colour (from the wallpaper) is the default on Android 12 and later;
  ship a static fallback scheme for older devices.
- Reference colour roles from the theme, never hard-coded hex values in
  components. Foreground uses the matching `on…` role for its container
  (`onPrimary` on `primary`).
- Large backgrounds use `surface` roles, not `primary` or `secondary`;
  `tertiary` only as a sparing accent.
- Light and dark themes both ship; dark surfaces use tonal elevation, not pure
  black. Offer a System / Light / Dark choice in settings.
- Generate custom palettes from a seed colour with the Material tooling rather
  than picking tones by hand.

## Navigation

| Window width | 3 to 5 destinations | More than 5 |
|---|---|---|
| Compact (< 600 dp) | navigation bar | modal drawer + navigation bar |
| Medium (600 to 839 dp) | navigation rail | modal drawer + rail |
| Expanded (≥ 840 dp) | navigation rail | permanent drawer |

- Navigation bar items always show labels; filled icon for the selected item,
  outlined for the rest.
- Support predictive back (Android 13+): opt in, handle back through the
  platform callbacks, do not suppress the preview animation.
- System back goes back in history; the Up arrow goes up in the hierarchy.
- Do not intercept back for "are you sure?" unless there is unsaved input.

## Layout

- Decide layouts by window size class, not device type or fixed pixel
  breakpoints; support at least compact and expanded.
- Margins 16 dp on compact, 24 dp on medium and expanded; 4, 8, or 12
  column grid respectively.
- On expanded widths, cap content at about 840 dp or use list-detail.
- Edge-to-edge is the norm (enforced from Android 15): draw behind system bars
  and pad content with window insets.
- Keep interactive elements out of system gesture zones (bottom about 20 dp,
  side edges about 24 dp).
- On foldables, keep critical content off the hinge; use the adaptive
  list-detail and supporting-pane scaffolds.

## Typography

- Use the Material type scale through the theme (body large 16 sp, body
  medium 14 sp, label large 14 sp for buttons).
- Text sizes in `sp` so font scaling works; body text not below 12 sp, labels
  not below 11 sp.
- Test at 200 % font scale: nothing clipped or overlapping.

## Components

- At most one floating action button per screen, bottom end, for the primary
  action; prefer the extended variant with a label.
- Top app bar with at most 2 to 3 action icons; the rest go to an overflow
  menu. The bar collapses with scrolling content.
- Bottom sheets have a visible drag handle and scroll when content is long.
- Dialogs only for decisions that need attention now; text buttons, dismiss
  to the left of confirm; titles as short questions or statements.
- Snackbars for brief, non-critical feedback with at most one action (often
  Undo); never for information the person must not miss.
- Chips in a horizontal scrolling row or flow layout, matched to purpose
  (filter, assist, input, suggestion).
- Every tappable element has a ripple; long press is never the only way to
  reach a feature and gives haptic feedback.
- Swipe-to-dismiss is undoable or confirmed.
- Acknowledge every action immediately (see `states.md#loading`).

## Accessibility

- Every interactive element has a content description of its action ("Add to
  favourites", not "heart icon"); decorative images have none.
- Group related elements into one TalkBack unit; expose swipe and long-press
  actions as custom accessibility actions.
- Touch targets 48×48 dp per Material; treat smaller as a hint and anything
  below 24×24 dp as a finding (consistent with the web rule). Enlarge with
  padding rather than shrinking spacing.
- Text contrast at least 4.5:1, large text (18 sp, or 14 sp bold) at least
  3:1; no meaning by colour alone.
- Focus order follows reading order; after navigation or closing a dialog,
  focus moves to a sensible target. Everything works with TalkBack, Switch
  Access, and a keyboard.
- Custom-drawn views expose a virtual accessibility tree.

## Permissions and notifications

- Request permissions in context with a rationale first; degrade gracefully
  when denied; never request unused permissions.
- Prefer privacy-preserving options: the photo picker instead of media
  permissions, approximate location unless precision is essential.
- One notification channel per notification type; conservative importance
  levels; every notification opens the relevant content.

## Checklist

- [ ] Dynamic colour with static fallback; no hard-coded colours in components
- [ ] Foreground colours use the matching `on…` role
- [ ] Light and dark themes supported; dark surfaces not pure black
- [ ] Navigation component matches window size class and destination count
- [ ] Navigation bar items have labels
- [ ] Predictive back supported; back not intercepted without unsaved input
- [ ] Edge-to-edge with insets; nothing interactive in gesture zones
- [ ] Content width capped or list-detail on expanded screens
- [ ] Text in `sp` via the type scale; usable at 200 % font scale
- [ ] At most one FAB; at most 2 to 3 app bar actions
- [ ] Dialogs only for urgent decisions; snackbars only for non-critical feedback
- [ ] Content descriptions describe actions; decorative images have none
- [ ] Targets 48 dp (hint below, finding below 24 dp)
- [ ] Contrast ≥ 4.5:1 (large ≥ 3:1); no meaning by colour alone
- [ ] Gestures and long press have accessible alternatives
- [ ] Permissions requested in context with rationale; denial handled
