# Diff review

**Question:** What is wrong with this item's change as a whole?

One pass over the whole item diff, prompted for refutation. The per-task reviews already checked
each task against its brief, so this pass looks at the whole and at what falls between tasks:
seams, leftovers, things no single task owned.

## Inputs

Besides the contract: the diff as a file (including untracked files), the requirement (the spec
from the item's Definition of Done) and the list of changed files. Never the
implementer's reasoning.

## Sweep

Probe the changed files for these (adapt the syntax to the languages in scope) and judge every hit:

- Hand-rolled escaping: `sed 's/`, `.replace(`, `str_replace(` on data bound for a URL, query,
  shell, SQL, HTML or JSON; manual `%20`/`&amp;`; string-built URLs and queries.
- Swallowed errors: `|| true`, `|| echo`, `2>/dev/null`, `except: pass`, `catch {}`, `@` in PHP,
  `?:`/`??`/`||` right after a call that can return an error object.
- Early-exit readers in pipes under `pipefail`: `grep -q`, `grep -m`, `head`, `read`, `awk … exit`.
- Variables used but never assigned; exit codes not checked after network, disk or process calls.
- Writes, deletes, publishes, sends: is the object's state checked right there?
- Leftovers added by the diff: `TODO`/`FIXME`, `console.log`/`print(`/`dbg!`, commented-out code.

## Checks

**Scope** — does the diff do what the requirement asks, and nothing else?
- Missing: every place that must change together — callers of a changed signature, other
  implementations of an interface, migrations for a model change, docs and config for a new
  option, both branches of a platform split.
- Stray: hunks the requirement does not explain (debug code, unrelated reformatting, files outside
  the item, files another session left in the tree).
- Tests: the change must not weaken a test, check or threshold to get green; each behaviour change has a test that would fail without it; tests that only assert that
  code runs, or mirror the implementation, do not count.
- Project rules: read CLAUDE.md/AGENTS.md (root and nearest to changed files); a broken explicit rule is a finding, quoted — critical if phrased must/never/always, else note.
- Irreversible: anything `git revert` cannot undo (migrations, data changes, deploy steps, messages
  to real recipients). For migrations: is there a rollback path, and does it work?

**Defects** — construct the input that breaks the line, or drop it:
- Obvious slips: typos in names and keys, inverted conditions, the wrong variable, copy-paste leftovers.
- Assumptions: non-empty, loaded, unique, logged in, a success return — where the caller does not
  guarantee it (error objects, `null`, `false`, empty collections used as the happy-path type).
- State: an operation allowed in a state it should not be; a status that can be skipped; a retry
  that runs twice.
- Boundaries: zero/one/many, first/last, empty vs missing vs `null`, off-by-one, `>` vs `>=`, size
  limits of integers, dates and strings.
- Data lifecycle: read after delete, double writes, partial writes when step 2 of 3 fails, stale cache.
- Error paths: swallowed errors that let a wrong value through; a failure in cleanup that masks the
  original error.
- Time and concurrency: two requests at once, a job overlapping its next run, check-then-act gaps,
  timezones, "now" read twice, timeouts shorter than the work.
- Platform: permissions, locale, GNU vs BSD tools, container vs host paths, missing binaries.
- Escaping: every boundary into URL, shell, SQL, HTML, JSON, regex or file name uses the library
  meant for it; for hand-rolled escaping, name the input it breaks and what the receiver does with
  the broken value.

**Cleanup** — what a simplification pass would look for:
- Start each note with a tag: `reuse:` (existing helper re-implemented), `stdlib:`, `native:`
  (platform feature), `yagni:` (built for a case no requirement asks for), `delete:` (dead code
  the item left: functions, parameters, imports, branches, flags).
- A file the item grows past ~1000 lines: note "split before adding".
- Duplication introduced by the item, across tasks too.
- Needless work in hot paths: repeated computation in loops, a query per item, re-reading a file.
- Names that do not say what things are; clever code where plain code works.

Cleanup findings are always notes, never critical.

## Severity

**critical** — a defect or scope violation that ships a wrong result or loses data: a reachable
failing input, a missing part of the requirement, behaviour the requirement did not ask for, an
irreversible step without a halt, a broken contract for any input (`CONTRACT.md`). Everything else is a note.

## Output

The contract format, analyzer name `Diff review`. In `Checked:`, name the three groups and the
sweep counts.
