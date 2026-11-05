# Adding work that belongs to an epic (example-org/shop)

You are a Claude Code session in the folder of the owner's project `example-org/shop`. Studio 0.11 is set up
there and `studio` is on your Bash tool's `PATH`. The project has `src/checkout/` and `src/cart/`. No lead loop
is running. `studio epic list` prints:

```
ID   STATUS  PROGRESS  ITEMS              TITLE
E-1  open    2/4       ready 1, merged 2  Pay by invoice
E-2  open    0/1       ready 1            Faster search
```

The owner types:

> The invoice option in the checkout shows the wrong VAT. Can you put that on the list?

## Your task

Say, step by step, what you do and what you tell the owner. Name each command you run, with all its options.
Reply in at most ten lines. Do not run anything.
