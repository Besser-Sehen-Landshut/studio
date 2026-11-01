# Security policy

Please report vulnerabilities through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection. `main` and any ref listed in `crew_allowed_workflow_refs` must be protected server-side.

## Crew credentials

Studio itself writes no crew credential to state, board, brief, settings, logs or errors, and never prints it. Output of crew commands is logged as is, so a crew printing its environment would put its credentials in the crew log, which lies in a state directory with mode 0700. A provider's token reaches only the environment of the crew process, as does the crew's GitHub token. That means crew shell commands can see both tokens in their environment: keep the GitHub token least-privilege, and treat a crew as able to use its model credential while it runs.

Crews ignore the project and local Claude Code settings of their clone: every launch, fresh or resumed, passes `--setting-sources user`, so only the user settings and the settings file Studio passes with `--settings` apply. Hooks, `env` and `apiKeyHelper` committed to a repository cannot redirect the Claude process, which runs outside the sandbox, or capture a newly issued token. Crews do not auto-load the project `CLAUDE.md`, rules, skills, commands or subagents; the brief tells them to read `AGENTS.md` and `CLAUDE.md` from `origin/main` with `git show`, not from the working tree, refusing any entry whose mode is not 100644. These files are ordinary project content: they cannot change settings or Studio's rules and can never direct a crew to handle credentials, change remotes, reach new hosts or change the report contract. A launch refuses when a role's required skill is definitely absent from the crew's config dir. Studio checks only the owner's own `settings.json` for API billing keys.

The owner config directory, including the `crew-token` file, is denied to crew shell commands and file tools, also when `XDG_CONFIG_HOME` lies outside the home. When a provider returns a `CLAUDE_CONFIG_DIR`, the sandbox allows reading exactly that directory, because the session needs it. The sandbox boundary then does not protect that login from crew shell commands; the guard denies it to the crew's file tools only as a second net. Other logins below the owner config directory stay denied.

The provider is a program the owner configured: it is accepted only from the owner config, as an absolute path to a regular file owned by the current user that neither group nor others can write. It gets a minimal environment, and its output is parsed strictly and never echoed. API billing is off by default, see the README.

Limit and account block detection read crew logs, which contain untrusted tool output, so they match only top-level events from Claude Code. A forged limit event could at worst stop that run and park its label for at most 8 days. A forged block event could stop all crews of this project until the owner clears it with `studio accounts-clear`, which needs a terminal; that is the safe direction, since it only stops work. The block state lies in the state root, which crews cannot write: the sandbox allows writes only to the clone, the tmp dir and the crew `HOME`, and the guard denies `blocks.json` to file tools and `studio accounts-clear` to crew shell commands.
