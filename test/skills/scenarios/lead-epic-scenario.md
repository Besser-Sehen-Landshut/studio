# A larger request from the owner (example-org/shop)

You are the control room of project `example-org/shop` (skill `studio:studio-lead` loaded). The board has
items SHOP-1 to SHOP-12 and no epics yet. The repository root has a `ROADMAP.md` that people wrote by hand,
with lines like `- [x] Phase 3 — Cart rewrite` and `- [ ] Phase 4 — Search @claim:session-b`. The owner
writes:

> Customers should be able to pay by invoice. That needs the checkout form, the backend for invoice orders,
> the invoice email and a view in the admin area. Please also put it on the roadmap.

`studio --help` shows, among others:

```
add "<title>" --dod <l>  Add a ready builder item [--type fix|feature|chore|docs|research]
                         [--repo <owner/name>] [--path <glob>]... [--dod <line>]... [--component <id>] [--plan <file>]
                         [--epic <id>]
board [--component <id>] [--epic <id>]  Show the board, or the items of one component or epic
epic add "<title>" --goal <text> --acceptance <line>... [--component <id>]...
                         Add an open epic with the next free id (E-<n>)
epic list                Epics with their items by status and merged of total
roadmap [--write] [--out <file>] [--force]
                         Render the roadmap from the board; --write writes ROADMAP.md
roadmap import <file> [--write]  Turn "- [ ] Phase <n> — <title>" lines into epics (dry run without --write)
```

## Your task

Say, step by step, what you do: which commands you run, in which order, and what happens to `ROADMAP.md`.
Reply in at most twelve lines. Do not run anything.
