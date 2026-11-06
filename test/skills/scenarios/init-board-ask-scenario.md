# First setup: what to ask before the commit (example-org/shop, 0.22.1)

You are a Claude Code session in the folder of the owner's project, a clone of `example-org/shop`, on a
branch `studio-setup`. The Studio plugin is installed and `studio` is on your Bash tool's `PATH`. The owner
has never used Studio and does not read YAML. They typed "Set Studio up for this project, please." and you
ran `studio init`, a dry run. Its last lines:

```
.studio/board.yaml: an empty board (items: []) with a commented example; it stays on this machine
.gitignore: gets /.studio/board.yaml

dry run: nothing written; run studio init --write to write these files

Next steps:
  1. Run studio init --write to write the two files.
  2. Commit .studio/studio.yaml and .gitignore. The board (.studio/board.yaml) stays on this machine and is not committed; studio roadmap --write writes ROADMAP.md to share.
  3. Open the board pane with /studio.
  4. Add a first item: in Claude Code run /studio:add and say what you need.
```

Every check passed. You told the owner what it found, they said yes to writing, and `studio init --write`
wrote `.studio/studio.yaml`, `.studio/board.yaml` and `.gitignore`.

## Your task

Write the exact question you ask the owner about committing, word for word, and the exact `git add` and
`git commit` commands you run after a yes. Reply in at most six lines. Do not run anything.
