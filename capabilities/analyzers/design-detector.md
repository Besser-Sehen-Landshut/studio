# Design detector (web UI items)

**Question:** Does this change ship web UI with known anti-patterns — generic AI-generated tells
(side-tab borders, purple gradients, bounce easing, dark glows, overused fonts) or plain design
quality problems (line length, cramped padding, tiny text, skipped headings, low contrast)?

Scope: the changed web UI files (`*.tsx`, `*.jsx`, `*.svelte`, `*.vue`, `*.astro`, `*.html`,
`*.css`, plus `*.scss`/`*.less` if present) and the stylesheets they import.

## Source

This analyzer reads fetched sources only. The brief lists the fetched file: the rule set of
impeccable's deterministic detector ([pbakaus/impeccable](https://github.com/pbakaus/impeccable),
Apache-2.0), or the output of a detector binary the project already has. Nothing is installed,
built or downloaded to run it, and the network is not used.

When the brief lists no such file or binary, stop and return `Result: skipped: no detector source
in the brief`. A skip is never "no findings" and never counts as a pass; the lead records the text
`skipped: <reason>` as the evidence for the check.

## Sweep

The sweep applies the listed rules to the scope — by reading the fetched rule file against the
changed files with `grep`/`rg`, or by running the project's own detector binary when the brief
names one:

- Every hit is a candidate (rule id, file, line or selector, snippet). Advisory rules produce
  candidates too, judged like the rest.
- If the binary or the scan fails, or the scope has no matching files, return
  `Result: skipped: <reason>` — never a pass.
- If the brief notes that the rule file is older than the upstream version, quote that note in
  `Checked:` so the report shows it.

Do not run the detector against URLs. Respect the project's own ignore configuration and in-file
disable comments: they are deliberate.

## Judge each candidate

Open the file at the reported place and decide:

1. **Real and in scope?** The finding points at code this item changed or now renders. A finding
   in an untouched file the scan pulled in through an import goes under "Outside scope".
2. **Intentional?** The project's brand rules or design tokens may require exactly this
   (a brand font, a gradient in the logo). Then dismiss it with that reason and suggest an
   inline disable comment with the rule and the reason instead of a silent pass.
3. **Visible?** Static scans see source, not the rendered page. A rule that depends on layout
   (contrast against an image, overflow) is a candidate to verify, not a confirmed finding — say
   what would confirm it (viewport, state).

## Critical when

Text that fails contrast or is unreadably small (`low-contrast`, `gray-on-color`, `tiny-text`) on a
primary path, content hidden or clipped so a task cannot be completed (`content-hidden-at-rest`,
`text-overflow`, `clipped-overflow-container`), or a `script-error`. Everything else — including
all AI-slop tells — is a note.
