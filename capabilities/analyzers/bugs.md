# Bug hunt

**Question:** Where does this code do the wrong thing for an input, state or order of events that
can really occur?

Work through the lenses below. For each, look for the concrete input that breaks the code — if you
cannot construct one, it is not a finding.

## Lenses

1. **Assumptions.** What must be true for this line to work — non-empty, already loaded, unique,
   sorted, logged in, same timezone, a success return? Find where the code relies on it and where
   the caller does not guarantee it. Especially: return values that can be an error object, `null`,
   `false` or an empty collection and are used as if they were the happy-path type.
2. **Boundaries.** Zero, one, many; first and last element; empty string vs missing vs `null`;
   off-by-one in ranges and pagination; limits of integer, date and string sizes; inclusive vs
   exclusive comparisons (`>` vs `>=` at "today").
3. **State and transitions.** Which states can an object be in, and does every operation check that
   the current state allows it? An action meant for drafts that also works on published items; a
   retry that runs twice; a status that can be skipped.
4. **Data lifecycle.** Created → changed → deleted: is anything read after it was removed, written
   twice, left behind on failure, or cached past its change? Partial writes when step 2 of 3 fails.
5. **Error paths.** What happens when a call fails, times out or returns something unexpected? Is
   the error swallowed (`catch {}`, `|| true`, `2>/dev/null`) so that the caller carries on with a
   wrong value? Does a failure in cleanup mask the original error?
6. **Time and concurrency.** Two requests at once, a job that overlaps its next run, a check-then-act
   gap, clocks and timezones, "now" read twice in one operation, timeouts that are shorter than the
   work.
7. **Encoding and escaping at boundaries.** Wherever data crosses into another language or
   protocol — URL, query string, shell command, SQL, JSON, HTML, regex, CSV, file name — check that
   *every* special character is handled, by the library meant for it. Hand-rolled escaping (a `sed`
   or `replace` for two or three characters) is a finding: list a realistic input it breaks, and
   check what the receiver does with the broken value — a parse error that is swallowed turns into
   a silent wrong result.
8. **Environment divergence.** What differs between where it was tested and where it runs: user and
   file permissions, locale and number formats, OS tools (GNU vs BSD), missing binaries, container
   vs host paths, feature flags, different shells.

## Sweep

Probe for these (adapt the syntax to the languages in scope) and judge every hit:

- **Hand-rolled escaping and encoding:** `sed 's/` or `.replace(` / `str_replace(` applied to data
  that goes into a URL, query, shell, SQL, HTML or JSON; manual `%20`/`%22`/`&amp;`; string-built
  URLs and queries.
- **Swallowed errors and defaults that hide them:** `|| true`, `|| echo`, `2>/dev/null`,
  `except: pass`, `catch {}`/`catch (_)`, `?:`/`??`/`||` right after a call that can return an error
  object, `@` error suppression in PHP.
- **Early-exit readers in pipes under `pipefail`:** `grep -q`, `grep -m`, `head`, `read`, `awk … exit`.
- **Variables used but never assigned** (compare assignments with uses, including in strings) and
  **exit codes not checked** after calls that talk to the network, disk or another process.
- **Status and permission checks around writes:** every call that writes, deletes, publishes or
  sends — is the object's state checked right there?

## Language notes

- **Shell:** `set -e` / `pipefail` with `grep -q`, `grep -m1` or `head` in a pipe (SIGPIPE turns a
  success into a failure); unquoted variables; `local x=$(cmd)` hiding the exit code; `read` without
  a trailing newline; GNU-only flags on macOS.
- **PHP / WordPress:** functions that return `WP_Error` or `false` instead of throwing (`?:` and
  `??` do not catch `WP_Error`); capability checks vs nonce checks (a nonce is not an authorization);
  `get_post_meta` single vs array; filters that run in admin and frontend.
- **TypeScript / JavaScript:** `await` missing in a loop or `forEach`; truthiness of `0` and `""`;
  `==` coercion; server/client boundary assumptions; unhandled promise rejections.
- **Swift:** main-actor isolation of UI state; `Task` outliving its view; force unwraps on
  external data; retain cycles in escaping closures; `@State` initialised from a changing input.
- **Rust:** `unwrap`/`expect` on external input; integer overflow in release builds; blocking calls
  inside async; lock held across `.await`.
- **Python:** mutable default arguments; naive vs aware datetimes; broad `except`; iterating while
  mutating.
- **SQL:** `NULL` in comparisons and `NOT IN`; implicit casts; missing `GROUP BY` producing
  duplicates from joins.

## Critical when

The failing input is reachable in normal use, or by anyone who can send a request, and the outcome
is a wrong result, lost or corrupted data, a crash or a hang.
