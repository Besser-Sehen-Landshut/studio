# Density critique

A procedure for critiquing one screen (a draft, mockup, or screenshot) for how
much it shows and how well that matches what the person is trying to do. It
judges information, not visual style. Run it per screen, not per product.

## Before you start

1. Name the screen and its **primary task** in one sentence ("check whether
   today's orders shipped"). If you cannot, that is the first finding.
2. Name the **primary user** and how often they use the screen (daily expert
   tools tolerate more density than occasional consumer screens).
3. Look at the screen at its real size and, for responsive UIs, at the
   narrowest supported width as well.

## Dimension 1: cognitive load

How much must a person keep in mind to finish the primary task?

- Count the decisions and distinct pieces of information needed for the task.
  More than about seven competing items at the same level is a warning sign.
- Look for elements serving a different goal than the primary task (promos,
  unrelated metrics, metadata noise, decoration).
- Check whether the screen tries to serve several jobs at once that would be
  clearer as separate views or modes.
- Check whether people must remember something from a previous screen that
  could be shown here instead.

## Dimension 2: prioritisation

Is the most important thing the most visible thing?

- The information needed to act is visible without scrolling on the target
  viewport.
- Primary content outranks supporting content in size, weight, and position;
  context and metadata are visibly secondary.
- Look for items with equal visual weight but unequal importance (three
  identical buttons, all-bold tables, many badges).
- Ask what the person would miss if they never hovered, expanded, or zoomed;
  anything decision-relevant that only appears that way is a finding.

## Dimension 3: scanning

Does the layout support how people skim rather than read?

- Lists, tables, and settings follow a left-aligned vertical scan; marketing
  style blocks with one call to action follow a diagonal path. Check the
  layout fits the content type.
- Labels are aligned and consistent so the eye can run down one edge.
- Numbers are right-aligned with tabular figures; dates, statuses, and units
  are formatted the same way in every row.
- Text is chunked: headings, short paragraphs, lists. Dense prose blocks in a
  task UI are a finding.
- Tables: check how many columns carry the task. If a few columns do most of
  the work, the rest are candidates for a detail view or column picker.

## Dimension 4: progressive disclosure

Is complexity revealed when needed, not all at once?

- Detail lives one step away (detail view, expandable row, side panel)
  rather than inline for every item.
- Collapsed sections, tabs, and dialogs hide genuinely secondary content,
  never the primary action or information needed to decide.
- Advanced and rare options are separated from the main path.
- There is one obvious starting point; if the eye does not know where to begin,
  too much is shown at the same level.

## Output format

Report every dimension in this fixed shape, in this order, even when it
passes:

```
### <Dimension>
Observation: <what is on screen, neutral and factual>
Problem: <what fails and why it matters for the primary task; "none" if pass>
Fix: <one concrete change, e.g. "move the shipping status column to position 2
      and drop the internal ID column into the detail view"; "none" if pass>
Rating: pass | minor | major
```

Rating guide:

- **pass**: no change needed for the primary task.
- **minor**: slows people down or adds noise, but the task succeeds.
- **major**: people are likely to miss information, pick the wrong action, or
  give up.

Finish with one line: the single change with the largest effect. Fixes must be
specific enough to implement without another question; "simplify the layout"
is not a fix.

## Typical findings and their usual fix

| Symptom on screen | Usual fix |
|---|---|
| A status page with twelve KPI tiles of equal size | keep the two or three that trigger a decision, link the rest |
| An order view listing every invoice, shipment, and note in full | show counts or the latest entry, open the rest on demand |
| A settings page where rare switches sit next to daily ones | move rare switches under an "Advanced" heading |
| A search result row with eight metadata fields | keep title, one status, one date; the rest in the detail view |
| A welcome screen with three paragraphs before the first button | one sentence, then the action |

## Checklist

- [ ] The screen's primary task fits in one sentence
- [ ] No element serves a goal unrelated to the primary task
- [ ] Information needed to act is visible without scrolling
- [ ] Visual weight follows importance; no row of equal-weight competitors
- [ ] No critical information hidden in tooltips, truncation, or faint text
- [ ] Labels aligned; numbers right-aligned with tabular figures
- [ ] Text is chunked into headings, short paragraphs, and lists
- [ ] Rarely used columns, fields, and options move to detail or advanced views
- [ ] Collapsed areas never hide the primary action
- [ ] There is one obvious starting point on the screen
- [ ] Critique output covers all four dimensions with observation, problem, fix, rating
