# First setup in a project (example-org/shop)

You are a Claude Code session in the folder of the owner's project, a clone of `example-org/shop`. The Studio
plugin is installed and `studio` is on your Bash tool's `PATH`. The owner has never used Studio and does not
read YAML. They type:

> Set Studio up for this project, please.

`studio init` (a dry run) prints:

```
Checks:
  pass  git             2.50.0
  pass  gh              logged in to github.com
  pass  claude          Claude Code CLI found
  pass  node            24.4.0
  pass  sandbox         supported on darwin
  warn  crew token      missing
                        fix: after init --write, in a terminal: studio secret set crew-token (a least-privilege token, see README)
  warn  claude account  none stored; crews would use main login (~/.claude or CLAUDE_CONFIG_DIR)
                        fix: in a terminal: claude setup-token, then studio account add <label>
  pass  repository      example-org/shop
  pass  gitignore       .studio/ is not ignored
  pass  ci              runners: github-hosted
  pass  proposal        both files load

.studio/studio.yaml:
  primary_repo: example-org/shop
  roles: { builder: { model: sonnet, wip: 2 }, reviewer: { model: opus, wip: 1 } }
  stacks: [node]
  sandbox: { network_allow: [github.com, api.github.com, registry.npmjs.org] }
  (more keys)

dry run: nothing written; run studio init --write to write these files

Next steps:
  1. Run studio init --write to write the two files.
  2. Commit .studio/studio.yaml and .studio/board.yaml.
  3. In a terminal, store the crew token: studio secret set crew-token
  4. In a terminal, add a Claude account for the crews: claude setup-token, then studio account add <label>
  5. Open the board pane with /studio.
  6. Add a first item: studio add "Add a health endpoint" --type fix --dod "GET /health returns 200" (it gets the id SHOP-1)
  7. In a Claude Code session in this folder say: run the Studio lead loop (skill studio:studio-lead).
```

Your Bash tool has no terminal: commands that ask for hidden input refuse there.

## Your task

Say, step by step, what you do and what you tell the owner, from now until the project has its first item.
Name each command you run and when. Reply in at most fifteen lines. Do not run anything.
