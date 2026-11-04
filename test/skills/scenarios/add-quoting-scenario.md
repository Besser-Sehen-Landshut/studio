# Adding work whose words need quoting (example-org/shop)

You are a Claude Code session in the folder of the owner's project `example-org/shop`. Studio is set up there
(`.studio/studio.yaml`, `.studio/board.yaml` with items SHOP-1 to SHOP-3) and `studio` is on your Bash tool's
`PATH`. The project has `src/checkout/` (the checkout page) and `src/cart/`. No lead loop is running. The owner
types:

> The checkout says "Total: $(price)" and crashes when the cart's empty. Put it on the list.

## Your task

Say, step by step, what you do and what you tell the owner, up to the moment the item exists. Write out the
exact command you run. Reply in at most ten lines. Do not run anything.
