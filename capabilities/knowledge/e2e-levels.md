# End-to-end and integration tests: levels

If the item touched no user flow, leave the end-to-end check out of the report; do not tick it.

**What this check must prove:** the user flows the item touched work end to end on the candidate —
through the real UI or the real public interface, with the assertions that matter to a user. The
tool is secondary; what counts is which flows and assertions actually ran.

**Step 1: Name the flows and assertions.** From the item's Definition of Done (DoD), list the user
flows the item changed or added and, per flow, the assertions that prove it works (for example
"valid checkout completes", "invalid field shows its message", "form submits with the keyboard").
This list is what the check is measured against.

**Step 2: Pick the level that can actually exercise them.**

| Technology                                 | Proves UI flows                                                      | Does **not** prove UI flows on its own        |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------- |
| Web app (Next.js, React, Vue, Svelte, ...) | Playwright (preferred), Cypress, Vitest Browser Mode                 | unit tests, component tests without a browser |
| REST/GraphQL API (no UI)                   | integration tests against a running server (`supertest`, HTTP calls) | unit tests of handlers                        |
| CLI tool                                   | tests that run the built binary with real arguments                  | unit tests of internal functions              |
| Native app (iOS/macOS)                     | XCUITest (UI tests in `xcodebuild test`)                             | XCTest/Swift Testing unit tests               |
| Native app (Windows/WinUI)                 | UI automation (WinAppDriver, FlaUI, Appium)                          | xUnit unit tests                              |
| Library/package                            | the public API tested as a consumer would call it                    | —                                             |
| Hybrid (web app + API)                     | browser tests for UI parts, integration tests for API parts          | —                                             |

A **substitute** for the preferred tool counts only if it runs the same flows with the same
assertions against the same candidate (for example Cypress instead of Playwright, or a Playwright
CLI run instead of a Playwright MCP session). Record which substitute ran and which flows and
assertions it covered. A unit suite, a build or a screenshot is never a substitute for a UI flow.

**Step 3: Find the project's infrastructure.**
- `playwright.config.*` means Playwright; `cypress.config.*` means Cypress; `vitest.config.*` with
  browser mode means Vitest Browser.
- `package.json` scripts `test:e2e`, `test:integration`, `e2e`: use those.
- An `.xcodeproj` with a UI test target means XCUITest; a `*.csproj` with a UI automation project
  means that.

**Step 4: Run.** Matching specs for the changed area first, then the full relevant suite to catch
regressions. For every flow from step 1, record which test covered it and its result.

**Step 5: Missing coverage.** A changed flow without a test gets one now — written from the
requirement, seen failing once against a deliberately broken implementation, then green (as the
spec check requires).

**No infrastructure for the needed level** (no browser runner, no UI test target): that is neither a
pass nor a skip. Either set up the smallest runner that can cover the flows (with the user's
agreement if it adds dependencies), or the end-to-end check stays open and the item is not done;
record in the report which flows are unverified and why.

**Failures:**
- Caused by the item: fix, rerun.
- Believed to be pre-existing: only with proof — the same failure with the same cause, reproduced
  on the unchanged base; the change neither causes nor hides anything; the tests covering this
  item's flows still run and pass. Then the item completes _with a known pre-existing failure_,
  named as such — never "all green". A flaky test without proof is not pre-existing. None of this
  excuses a failing required CI run.
- After fixes: rerun the failing tests on the new candidate.
- A failed Playwright run (local or CI artifact) that left a trace `.zip`: open the trace viewer
  before guessing from the error text; if it is unavailable, say so and read the report instead.
