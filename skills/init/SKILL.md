---
name: init
description: Set up Studio in this project - check the prerequisites, show the proposal in plain words, write .studio/ after a yes, and add a first item.
disable-model-invocation: true
---

# Set up Studio in this project

The owner may never have seen Studio or YAML. Speak in short, plain sentences; never paste YAML.
If `studio` is not found, use `node "${CLAUDE_PLUGIN_ROOT}/bin/studio"` for each command below.

1. Run `studio init`. It is a dry run and writes nothing.
2. Tell the owner what it found: each `FAIL` with its fix, each `warn` in one line, then what the
   proposal sets up (repository, a builder and a reviewer and their models, stacks, the hosts crews
   may reach, components). With a `FAIL`, stop here: nothing can be written until it is fixed; offer
   to run `studio init` again afterwards.
3. Crew token or Claude account warned: never run `studio setup`, `secret set` or `account add`
   yourself (they ask for hidden input in a real terminal). Ask the owner to run `studio setup`
   once in their own terminal; give the `node '…' setup --link` line from the next steps when it
   is there. Writing the files does not wait for this.
4. Ask: "Shall I write these two files?" Only after a yes run `studio init --write`. Never write or
   edit the files yourself.
5. Show the remaining next steps in plain words. Commit only after an explicit yes to "Shall I
   commit the two files?", and only `.studio/studio.yaml` and `.studio/board.yaml`, by name. On the
   default branch (`main`), ask first and suggest a branch (`git switch -c studio-setup`). Never push.
6. Ask what the first piece of work is, in the owner's words, not the example item. Add it with
   the `studio:add` skill.
