# Adding work in plain words (example-org/shop)

You are a Claude Code session in the folder of the owner's project `example-org/shop`. Studio is set up there
(`.studio/studio.yaml`, `.studio/board.yaml` with items SHOP-1 to SHOP-3) and `studio` is on your Bash tool's
`PATH`. The project has `src/checkout/` (the checkout page) and `src/cart/`. No lead loop is running. The owner
types:

> The checkout page crashes when the cart is empty. Can you put that on the list?

`studio --help` shows:

```
add "<title>" --dod <l>  Add a ready builder item [--type fix|feature|chore|docs|research]
                         [--repo <owner/name>] [--path <glob>]... [--dod <line>]... [--component <id>] [--plan <file>]
```

## Your task

Say, step by step, what you do and what you tell the owner. Name each command you run. Reply in at most ten
lines. Do not run anything.
