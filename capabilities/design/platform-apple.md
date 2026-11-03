# Platform: Apple

Source: see ../NOTICE.md (condensed and rephrased from ehmo/platform-design-skills, MIT).

Most-used rules from Apple's Human Interface Guidelines. The shared part
applies everywhere (iPhone is the baseline); device sections add differences.

## Shared: layout and navigation

- Respect safe areas (status bar, Dynamic Island, home indicator); only
  backgrounds extend into them. Spacing on an 8 pt grid (4 pt fine steps).
- iPhone: tab bar at the bottom for 3 to 5 top-level sections; no hamburger
  menu. The tab bar stays visible while drilling down within a tab.
- Hierarchical content uses a navigation stack; the edge swipe back always
  works, also with a custom back button.
- State (scroll, selection, input) survives switching tabs. Layouts work from
  375 pt to the largest iPhone width; primary actions within thumb reach.

## Shared: type, colour, accessibility

- Use the built-in text styles; custom fonts scale with Dynamic Type. Layouts
  reflow at the largest accessibility sizes (about 200 %) without truncating
  essential text. No text below 11 pt.
- Semantic system colours, or asset colours with light, dark, and increased
  contrast variants. One accent colour for interactive elements.
- Contrast at least 4.5:1, large text 3:1; meaning never by colour alone.
- VoiceOver labels describe each control's function; reading order is logical.
- Respect Reduce Motion, Bold Text, Increase Contrast, and Reduce Transparency.
- Every gesture has a visible alternative (button or menu item); system
  gestures (edge swipes, home, Control Center) are never overridden.
- Touch targets 44×44 pt per Apple's guidance; treat smaller as a hint and
  anything below 24×24 pt as a finding (consistent with the web rule).

## Shared: components and patterns

- Buttons: one prominent style for the primary action, bordered for secondary,
  plain for tertiary; destructive actions use the destructive role.
- Alerts only for decisions that cannot wait; two buttons, at most three.
  Informational messages go inline or in a banner.
- Sheets for scoped tasks, always dismissable; no sheet on top of a sheet.
- Lists: rows at least 44 pt, swipe actions for frequent operations, with a
  non-swipe alternative.
- Skeletons or inline progress, no full-screen blocking spinner; launch screen
  mirrors the first screen, no logo splash.
- Permissions in context with an explanation first; Sign in with Apple next to
  other social sign-ins; basic use without an account where possible.
- Haptics accompany significant actions, never as the only signal.

## iPad

- Do not stretch the iPhone layout: in regular width a sidebar with two or
  three columns replaces the bottom tab bar.
- Works in Split View at one third, half, and two thirds, in Slide Over, and in
  Stage Manager at arbitrary sizes; never assume full screen.
- A detail pane is never blank; show a placeholder when nothing is selected.
- Pointer: hover states, right-click context menus, drag and drop between
  apps. Hardware keyboard: Command shortcuts for main actions, shown in the
  Command-hold overlay; Tab and arrow keys move focus.

## Mac

- Complete menu bar with standard menus; every command reachable there with a
  keyboard shortcut; context menus on content.
- Resizable windows with sensible minimums, remembered size and position,
  multiple windows where it makes sense, standard window controls.
- Toolbar for frequent actions (customisable) and a search field; collapsible
  sidebar on the leading edge.
- Compact controls (about 22 to 28 pt high); no touch-sized buttons, floating
  action button, or bottom tab bar. Margins 20 pt, 8 pt within groups.
- Escape cancels, Return is the default button, Command-Z undoes every change.

## Watch

- Key information readable within 2 seconds on the first screen without
  scrolling; sessions of 5 seconds or less.
- Body text at least 16 pt, titles 18 pt or more; one main datum per screen.
- Digital Crown scrolls and adjusts values with detents.
- Navigation at most 2 to 3 levels deep; the main action is one tap from launch.
- Always On: reduced detail, private data hidden, updates at most once a minute.

## TV

- Focus is the only pointer: every interactive element has an unmistakable
  focus state (scale, elevation, brightness, not colour alone); focus moves
  predictably, is never trapped, and is remembered when returning.
- Menu on the remote always goes back.
- Viewed from about 3 m: body text at least 29 pt, titles 48 pt or more;
  critical content within a 60 pt safe inset; few, large elements.
- Tab bar at the top with 3 to 7 labelled tabs.

## Vision

- Interactive targets at least 60 pt because gaze is imprecise; hover
  feedback on gaze for every interactive element.
- Primary content ahead at eye level, about 1 to 2 m away, nothing closer than
  about 0.5 m and nothing behind the user; anchored to the room, not the head.
- Glass material for windows; navigation as a leading ornament, actions as a
  bottom ornament; immersive spaces always have an exit.
- No gestures that require holding the hands up for long.

## Checklist

- [ ] Content respects safe areas; spacing follows the 8 pt grid
- [ ] Navigation fits the device: tab bar (iPhone), sidebar (iPad regular, Mac), top tab bar (TV)
- [ ] Back navigation (edge swipe, Menu button, Escape) always works
- [ ] Built-in text styles with Dynamic Type; layouts reflow at accessibility sizes
- [ ] Semantic colours with dark and increased-contrast variants
- [ ] Contrast ≥ 4.5:1 (large ≥ 3:1); no meaning by colour alone
- [ ] VoiceOver labels on all interactive elements, logical order
- [ ] Reduce Motion, Bold Text, Increase Contrast, Reduce Transparency respected
- [ ] Every gesture has a visible alternative; system gestures untouched
- [ ] Targets: 44 pt touch (hint below, finding below 24 pt), 60 pt Vision
- [ ] Alerts only for decisions; sheets dismissable and never stacked
- [ ] No full-screen blocking spinners; no logo splash
- [ ] Permissions requested in context with a prior explanation
- [ ] iPad: works in Split View, Slide Over, Stage Manager; pointer and keyboard supported
- [ ] Mac: full menu bar with shortcuts, resizable windows, undo everywhere
- [ ] Watch: glanceable first screen, body ≥ 16 pt, ≤ 3 navigation levels
- [ ] TV: visible focus state everywhere, body ≥ 29 pt, 60 pt safe inset
