# Forms

Guideline for any screen that collects input, from one search field to a
multi-step flow. Goal: people finish on the first attempt and never lose what
they typed. Error and empty states around the form live in `states.md`; the
wording of error messages lives in `ux-writing.md#error-messages`.

## Ask less

- Every field costs completions. Before adding one, ask whether the answer is
  needed now, can be derived, or can be asked later.
- Pre-fill what is known (account data, last used value, locale). Where one
  answer dominates, preselect it; a yes/no question should not start empty.
- High-stakes submissions (payment, legal, irreversible) get a review step.

## Layout

- One column. Side-by-side fields make the order ambiguous; only tightly
  coupled short pairs (city and postcode) may share a row where there is room.
- Field width hints at the expected answer: a postcode field is short, a
  description field is wide.
- Labels sit above their field. Above-field labels survive long translations
  and are read in one downward sweep.
- Long forms are split into titled groups. Related controls are grouped with a
  visible boundary or heading (on the web: `fieldset` plus `legend`).

## Labels and hints

- Every field has a visible label that stays visible while typing. A
  placeholder is never the label; at most it shows an example value.
- Labels are short, sentence case, no trailing colon clutter, no all caps.
- Format and constraint hints sit between label and field, right where they
  are needed, not in an intro paragraph people have forgotten by field six.
- When most fields are required, mark the optional ones ("optional") instead of
  starring the required ones. Whatever the marker, it is also exposed
  programmatically (`required`, `aria-required`).
- Limits are visible from the start ("120 characters max" plus a counter), not
  revealed only when someone hits them.

## Pick the right control

| Data | Control |
|---|---|
| Short free text | single-line input |
| Long free text | multi-line input that can grow |
| One of up to about five options | radio group, all options visible |
| One of many options | select or searchable combobox |
| Several of a few options | checkboxes |
| On/off that applies immediately | switch; on submit-style forms, a checkbox |
| Date | date picker or separate day/month/year inputs, never one free text box |
| Phone, card, IBAN | text input with tolerant formatting, accept spaces and dashes |
| Password | password input with a show/hide toggle, paste allowed |

On the web, choose `type` and `inputmode` for the right mobile keyboard and set
`autocomplete` for personal data so browsers and password managers can fill it.

## Validation

- Check a field when the person leaves it (blur), not on every keystroke.
  Exception: live feedback that helps while typing, such as password rules
  being ticked off or a username availability check.
- Once a field shows an error, re-check it while typing so it clears when fixed.
- Place the error directly under the field it belongs to, connected
  programmatically (`aria-describedby`, `aria-invalid`).
- Be tolerant on input: trim spaces, accept common separators, normalise case
  where it does not matter. Reject only what is really invalid.
- Server errors are mapped back to the affected field where possible. When
  several fields fail, show a summary at the top that receives focus; each
  entry jumps to its field.
- Never clear what the person typed after an error, including on server
  failures and timeouts. Passwords are the only acceptable exception.
- Success marks only where correctness is not obvious (availability, strength).

## Do not disable the submit button

Keep the primary button enabled and validate when it is pressed. A disabled
button cannot say why it is disabled, is often skipped by screen readers and
low in contrast, and leaves the person hunting for the missing piece. On
press, show all errors and move focus to the first invalid field or summary.
Prevent double submission with a busy state on the button (label plus
spinner), not by silently greying it out. If disabling is unavoidable, put a
visible explanation next to the button.

## Multi-step forms

- Show where the person is and how much is left: a row of named steps
  ("Address, Payment, Review") rather than a bare counter.
- Each step is a coherent unit; validate per step before moving on.
- Back never discards data. Long flows save progress automatically or offer
  "save and continue later".
- Leaving with unsaved input asks for confirmation; an untouched form does not.

## Accessibility

- Focus order follows the visual order; the first field gets focus only when
  the form is the main purpose of the screen.
- Required, error, and success states are never shown by colour alone; pair
  colour with text or an icon.
- Interactive targets are at least 24×24 CSS px (WCAG 2.2 SC 2.5.8); on touch
  screens 44×44 is recommended.
- Enter submits single-field forms; in multi-line inputs it inserts a line.

## Checklist

- [ ] Each field keeps a visible label while typing; no placeholder-only labels
- [ ] Format hints and limits are shown next to the field before input
- [ ] Optional (or required) fields are marked visibly and programmatically
- [ ] Single-column layout; groups have headings or `fieldset`/`legend`
- [ ] Control type matches the data (radios ≤ 5 options, no free-text dates)
- [ ] Web inputs set `type`, `inputmode`, and `autocomplete` where applicable
- [ ] Validation runs on blur or submit, not on every keystroke
- [ ] Errors appear under the field and are linked via `aria-describedby`
- [ ] Multiple errors produce a focusable summary linking to each field
- [ ] Input is preserved after client and server errors
- [ ] Submit button stays enabled; submission shows a busy state instead
- [ ] Multi-step flows show progress, keep data on Back, confirm discards
- [ ] States are not conveyed by colour alone
- [ ] Targets are ≥ 24×24 CSS px (≥ 44×44 on touch recommended)
- [ ] Irreversible or high-stakes submissions have a review step
