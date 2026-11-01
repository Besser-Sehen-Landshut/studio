# Similar bugs

**Question:** A reviewed item just had defects fixed. Where else in the codebase does the same mistake
exist?

Input, in addition to the contract: the list of fixes made in this item, each with the file, the
defect and the fix — for a refactor also the code it moved (old and new place). Without
either there is nothing to do — return "no findings".

## Procedure

1. **Name the pattern, not the instance.** For each fix, write down the mistake in a form that is
   independent of the concrete names: "a handler acts on an object without checking its status",
   "an error-returning call is defaulted with `?:`", "a pipe under `pipefail` ends in `grep -m1`".
2. **Derive search probes.** Several per pattern, from narrow to wide: the same function call, the
   same API family, the same shape in other syntax. Use `grep`/`rg` with context, and read each hit —
   a hit is a candidate, not a finding.
3. **Check each candidate against the original trace.** Does the same failing input reach it? A
   guarded call is not a finding; an unguarded one on a different path is.
4. **Search the whole codebase**, not only the item scope — that is the point of this step. Skip
   vendored and generated code.

## Output

Use the contract format. In the `Evidence` column, name the pattern the finding belongs to. Under
`Checked:`, list each pattern with the probes used and the number of hits reviewed — so that "no
findings" shows how hard it was looked for.

## Critical when

The same severity as the original fix applies: if the original was critical, a confirmed twin is
critical too.
