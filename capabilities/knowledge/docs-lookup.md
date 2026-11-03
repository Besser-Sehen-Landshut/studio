# Live docs lookup

Use this when a decision depends on a framework, library or tool. The order is fixed — take the
first source that exists and stop. A crew session has no MCP server, no web fetch and reaches only
the hosts in the project's allowlist, so for a crew the bundled docs are usually the only step;
without them, mark the fact UNVERIFIED rather than guess:

1. **Bundled** — docs or skills shipped inside the project's own packages (version-matched).
2. **Official access** — the vendor's docs MCP server, plugin or CLI, if the host already has it.
3. **`llms.txt`** — fetch the index, then single pages; never `llms-full.txt`.
4. **Context7** — pinned to the version the project resolves (lockfile), not "latest".

## The rule

A framework or library decision **quotes the doc it relies on** (path or URL plus line) **or is
marked `UNVERIFIED`**. Nothing reachable: say so (`skipped: <reason>`) and never answer from memory
as if it were the docs.

Reading is delegated: a reviewer or helper session does the reading and returns findings or a digest
of at most 40 lines. Official access is for reading docs only; nothing is installed for it.

## Where to look

Examples, not a complete list. "—" means that step does not exist for the technology; resolve
Context7 ids by name.

| Technology         | 1 Bundled                                          | 2 Official access                    | 3 `llms.txt` / site                      |
| ------------------ | -------------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| Next.js            | `node_modules/next/dist/docs/`                     | —                                    | https://nextjs.org/docs/llms.txt         |
| React              | —                                                  | —                                    | https://react.dev/llms.txt               |
| shadcn/ui          | —                                                  | `npx shadcn@latest docs <component>` | https://ui.shadcn.com/llms.txt           |
| PostgreSQL         | —                                                  | docs-search plugin, if present       | https://www.postgresql.org/docs/current/ |
| Zod                | —                                                  | —                                    | https://zod.dev/llms.txt                 |
| Vitest             | —                                                  | —                                    | https://vitest.dev/llms.txt              |
| Playwright         | `node_modules/playwright-core/lib/tools/skills/`   | —                                    | —                                        |
| Docker             | —                                                  | —                                    | https://docs.docker.com/llms.txt         |
| Tauri              | —                                                  | —                                    | https://tauri.app/llms.txt               |
| Rust               | `cargo doc` for the resolved crates                | —                                    | docs.rs page of the crate version        |
| Svelte / SvelteKit | —                                                  | Svelte MCP, if present               | https://svelte.dev/llms.txt              |
| TanStack           | `node_modules/@tanstack/*/skills/` (where shipped) | —                                    | https://tanstack.com/llms.txt            |
| Biome              | `biome explain <rule>`                             | —                                    | —                                        |
| Stripe             | —                                                  | —                                    | https://docs.stripe.com/llms.txt         |
| Sentry             | —                                                  | Sentry MCP, if present               | https://docs.sentry.io/llms.txt          |
| Astro              | —                                                  | Astro docs MCP, if present           | —                                        |
| Fastify            | `node_modules/fastify/docs/`                       | —                                    | https://fastify.dev/llms.txt             |
| Kotlin / Ktor      | —                                                  | —                                    | https://kotlinlang.org/llms.txt          |
| WordPress          | —                                                  | —                                    | https://developer.wordpress.org/         |
| pnpm               | `pnpm help <command>`                              | —                                    | —                                        |
