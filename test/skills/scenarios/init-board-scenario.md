# First setup, the board stays on the lead machine (example-org/shop, 0.22.1)

You are a Claude Code session in the folder of the owner's project, a clone of `example-org/shop`, on a
branch `studio-setup`. The Studio plugin is installed and `studio` is on your Bash tool's `PATH`. The owner
has never used Studio and does not read YAML. They typed "Set Studio up for this project, please.", you
ran `studio init` and told them what it found, and they said yes to writing the files.

`studio init --write` printed:

```
Checks:
  pass  git             2.50.0
  pass  gh              logged in to github.com
  pass  claude          Claude Code CLI found
  pass  node            24.4.0
  pass  sandbox         supported on darwin
  pass  crew token      stored
  pass  claude account  main
  pass  repository      example-org/shop
  pass  gitignore       .studio/studio.yaml is not ignored; --write adds /.studio/board.yaml to .gitignore
  pass  ci              runners: github-hosted
  pass  proposal        both files load

.studio/studio.yaml:
  primary_repo: example-org/shop
  (more keys)

.studio/board.yaml: an empty board (items: []) with a commented example; it stays on this machine
.gitignore: gets /.studio/board.yaml

written: .studio/studio.yaml, .studio/board.yaml, .gitignore

Next steps:
  1. Commit .studio/studio.yaml and .gitignore. The board (.studio/board.yaml) stays on this machine and is not committed; studio roadmap --write writes ROADMAP.md to share.
  2. Open the board pane with /studio.
  3. Add a first item: in Claude Code run /studio:add and say what you need.
  4. In a Claude Code session in this folder say: run the Studio lead loop (skill studio:studio-lead).
```

`git status --short` now shows:

```
 M .gitignore
?? .studio/
```

The owner says: "Yes, commit it."

## Your task

Say exactly which git commands you run now, in order, and what you tell the owner about the board. Reply
in at most ten lines. Do not run anything.
