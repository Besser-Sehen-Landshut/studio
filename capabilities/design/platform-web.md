# Platform: web

Source: see ../NOTICE.md (condensed and rephrased from ehmo/platform-design-skills, MIT).

Framework-independent rules based on WCAG 2.2 AA. Forms: `forms.md`;
loading, empty, and error states: `states.md`.

## Semantics and accessibility

- Use native elements for their purpose: `button` for actions, `a href` for
  navigation, `main`/`nav`/`header`/`footer`/`aside` as landmarks, `dialog`
  for dialogs. No clickable `div` or `span`.
- Prefer native HTML over ARIA; add ARIA only where no native element exists.
- Every interactive element has an accessible name. Icon-only buttons get an
  `aria-label`; the decorative icon gets `aria-hidden="true"`.
- When a control has visible text, its accessible name contains that text
  (SC 2.5.3), so voice control works.
- One `h1` per page; heading levels in order, styled with classes.
- Informative images describe content or function in `alt`; decorative: `alt=""`.
- Dynamic updates are announced: `role="status"` or `aria-live="polite"` by
  default, `role="alert"` only for urgent messages.
- `lang` on `html`; `dir="auto"` on user-generated text.

## Keyboard and focus

- Everything works with the keyboard alone (SC 2.1.1); no `tabindex` above 0.
- Focus is always visible (SC 2.4.7). Use `:focus-visible`; never remove the
  outline without a replacement of at least 2 px and 3:1 contrast.
- Focused elements are not hidden behind sticky headers or footers (SC 2.4.11).
- Modals trap focus while open, close on Escape, and return focus to the
  trigger when closed.
- A skip link to the main content is the first focusable element.
- Every hover interaction also works on focus and on tap; nothing essential is
  hover-only.

## Contrast and colour

- Text contrast at least 4.5:1; large text (24 px, or 18.66 px bold) at least
  3:1; UI component boundaries and meaningful graphics at least 3:1.
- Check contrast in light and dark themes separately.
- Never encode meaning in colour alone; add text, an icon, or a pattern.
- Theme with CSS custom properties; declare `color-scheme`; respect
  `prefers-color-scheme` and `prefers-contrast`, and use system colours under
  `forced-colors`.

## Target size

- Interactive targets at least 24×24 CSS px, or enough spacing that a 24 px
  circle around each does not overlap a neighbour (SC 2.5.8, AA). Below this is
  a finding.
- On touch layouts 44×44 CSS px is recommended; below this is a hint, not a
  failure. Enlarge the hit area with padding rather than the visual size.

## Responsive layout

- Mobile-first: base styles for the narrowest viewport, enhance with
  `min-width` queries. Set breakpoints where the content breaks, not at device
  widths (typical starting points: 30, 48, 64, 80 rem).
- Content reflows at 320 CSS px wide without horizontal scrolling (SC 1.4.10),
  except for content that needs two dimensions (data tables, maps).
- Include `<meta name="viewport" content="width=device-width, initial-scale=1">`;
  never `user-scalable=no` or `maximum-scale=1`.
- Use container queries for components that appear in different widths;
  `clamp()`, `min()`, `max()` for fluid type and spacing.
- Use logical properties (`margin-inline-start`, `inline-size`) so RTL works.

## Typography

- Sizes in `rem`, body text at least 16 px equivalent.
- Body line height at least 1.5; line length about 45 to 75 characters.
- Text stays readable with user spacing overrides (SC 1.4.12) and at 200 %
  zoom (SC 1.4.4).
- Tabular figures in tables; real quotes and dashes; no text baked into images.

## Navigation and state

- Each meaningful view has its own URL; filters, tabs, and pagination are in
  the URL so reload, back, and sharing work.
- Back and forward restore the previous state and scroll position.
- Mark the current location with `aria-current="page"`; breadcrumbs for deep
  hierarchies.

## Performance

- Images and embeds declare `width` and `height` (or `aspect-ratio`) to avoid
  layout shift; below-the-fold images use `loading="lazy"`.
- Preload critical fonts and the hero image; `preconnect` to required
  third-party origins.
- Split JavaScript by route and by rarely used feature.
- Virtualise lists beyond a few hundred rows.
- Acknowledge every action immediately (see `states.md#loading`).

## Motion

- Respect `prefers-reduced-motion`: remove non-essential motion, keep state
  changes instant or as a fade.
- Animate `transform` and `opacity` only; avoid animating layout properties.
- Nothing flashes more than three times per second (SC 2.3.1).
- Motion explains a change (where something came from or went); no motion
  purely for decoration in product UI.

## Checklist

- [ ] Native elements used for actions, links, landmarks, and dialogs
- [ ] Every interactive element has an accessible name containing its visible text
- [ ] Heading levels are in order with one `h1`
- [ ] Informative images have `alt`; decorative ones `alt=""`
- [ ] Full keyboard operation; focus always visible and never obscured
- [ ] Modals trap focus, close on Escape, and return focus
- [ ] Text contrast ≥ 4.5:1 (large ≥ 3:1), UI components ≥ 3:1, in both themes
- [ ] No information conveyed by colour alone
- [ ] Targets ≥ 24×24 CSS px (finding below); ≥ 44×44 on touch (hint below)
- [ ] No horizontal scrolling at 320 CSS px; zoom not disabled
- [ ] Nothing essential is hover-only
- [ ] View state lives in the URL; back/forward restore it
- [ ] Images declare dimensions; below-fold images lazy-load
- [ ] Dynamic updates use a live region
- [ ] `prefers-reduced-motion` honoured; only `transform`/`opacity` animated
- [ ] `lang` set; logical properties used for spacing and alignment
