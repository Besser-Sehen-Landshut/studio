# Project commands per stack

Use these to verify an item. **Run only what the project configures** — a missing linter or type
checker is "not configured", not a failure. Everything that runs must be green.

A `Makefile`, `justfile` or CI workflow that defines these steps wins over the tables below: run
what the project runs.

## JavaScript / TypeScript

Pick the package manager `$PM` from the lock file, once per session:

| Lock file                | Package manager                                              |
| ------------------------ | ------------------------------------------------------------ |
| `pnpm-lock.yaml`         | `pnpm`                                                       |
| `bun.lockb` / `bun.lock` | `bun`                                                        |
| `yarn.lock`              | `yarn`                                                       |
| `package-lock.json`      | `npm`                                                        |
| none                     | the first of `pnpm`, `bun`, `yarn` found in PATH, else `npm` |

Script names come from `package.json`: `$PM tsc --noEmit`, `$PM lint`, `$PM test`,
`$PM test:e2e` (or `$PM run ...`).

## Other stacks

| Stack               | Typecheck                            | Lint (if configured)                | Tests                                  |
| ------------------- | ------------------------------------ | ----------------------------------- | -------------------------------------- |
| Rust                | `cargo check`                        | `cargo clippy -- -D warnings`       | `cargo test`                           |
| Swift / iOS / macOS | covered by the production build      | `swiftlint`                         | `swift test` or `xcodebuild test`      |
| Go                  | `go vet ./...`                       | `golangci-lint run`                 | `go test ./...`                        |
| Python              | `mypy` / `pyright`                   | `ruff check`                        | `pytest`                               |
| PHP                 | `php -l` on changed files; `phpstan` | `phpcs`                             | `phpunit` or the project's test script |
| .NET / WinUI        | covered by the production build      | `dotnet format --verify-no-changes` | `dotnet test`                          |
