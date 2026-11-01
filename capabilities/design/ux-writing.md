# UX writing

Interface text is part of the design, not filler added at the end. Draft real
copy with the layout; lorem ipsum hides length problems and unclear flows.
Product UI copy is calm and plain. No hype, no exclamation marks in routine
messages, no jokes in error states.

## Principles

- Clear beats clever; a pun nobody gets is a bug.
- Short beats complete; cut words until meaning would suffer, then stop.
- Useful beats promotional; describe what happens, not how great it is.
- Consistent beats creative; one term per concept across the whole product.
- Address the person directly and neutrally; never blame them.

## Voice and tone

- **Voice** stays constant: vocabulary, form of address, level of formality.
  Decide it once per product and write it down (formal or informal address is
  decided per language).
- **Tone** adapts to the moment: neutral for instructions, calm and precise for
  errors, brief and warm for success. Severity rises with stakes, never
  decoration.

## Buttons and actions

- Start with a verb that names the outcome: "Save changes", "Send invoice",
  "Delete project". Avoid "Submit", "OK", "Yes" where a verb fits.
- The label matches what happens next; if the result differs by context,
  the label differs too.
- In dialogs, the confirming button repeats the verb from the title ("Delete
  file?" → "Delete"); the other one is "Cancel".
- One primary action per view; it is the most common next step for the
  person, not the one the business would prefer.
- Links describe their target ("View invoice"), never "click here".

## Labels, hints, placeholders

- Labels are nouns or short phrases in sentence case: "Email address".
- Hints explain format or why something is asked, in one line.
- Placeholders show an example value ("e.g. 80331"), never the label and
  never the instructions.
- Tooltips explain, they do not hold required information.

## Error messages

The single pattern for every error message in the product (`states.md` and
`forms.md` refer here):

1. **What happened**, in plain words ("Your changes were not saved.").
2. **Why**, if it helps and is known ("The connection was lost.").
3. **What to do now**, as a concrete step, ideally a button ("Try again").

Rules:

- Be specific: "Card number has 15 digits, needs 16" instead of "Invalid
  input". "Something went wrong" alone is never acceptable.
- No blame ("You entered…") and no technical jargon, codes, or exception names.
  A short support reference is fine as an addition.
- Keep the person's work in the sentence: say what was kept ("Your draft is
  saved locally").
- Field errors say how to fix the field, in one line.

## Confirmations and success

- Say what happened, in the past tense: "Invoice sent to the customer".
- Offer undo for reversible actions instead of asking first.
- Add the next step only if there is an obvious one.
- No celebration for routine actions; save it for real achievements.

## Empty states and onboarding copy

Structure and behaviour of empty states are defined in `states.md#empty`; the
copy there follows the principles above: one sentence on what will appear,
one action to start. Onboarding copy introduces one idea per screen, leads
with what the person can do, and always offers a way to skip.

## Numbers, dates, units

- Format with the locale (thousands separator, decimal mark, date order).
- Relative times for recent events ("5 minutes ago"), absolute dates for
  older ones; give the exact time on hover or long press.
- Always show the unit; avoid ambiguous abbreviations.

## Localisation

- Plan for text growth of 30 to 50 percent; layouts must not depend on the
  English length.
- Never build sentences from fragments; use complete strings with
  placeholders and real plural rules.
- Avoid idioms, wordplay, and culture-bound metaphors.
- Keep a short glossary of product terms and use it everywhere.

## Checklist

- [ ] Copy is real text, not placeholder text, in the reviewed draft
- [ ] Buttons start with a verb that names the outcome; no bare "Submit" or "OK"
- [ ] Dialog confirm buttons repeat the verb of the dialog title
- [ ] One primary action per view
- [ ] Link texts describe their target
- [ ] Placeholders hold example values only, never labels or instructions
- [ ] Error messages state what happened, why (if known), and what to do
- [ ] No "Something went wrong" without specifics; no codes or jargon alone
- [ ] Messages never blame the person
- [ ] Success messages are past tense and offer undo where reversible
- [ ] One term per concept throughout the product
- [ ] Numbers, dates, and units are locale-formatted
- [ ] Layouts tolerate 30 to 50 percent longer translations
- [ ] Tone is calm and plain; no hype or exclamation marks in routine UI
