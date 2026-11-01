# Security policy

Please report vulnerabilities through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection. `main` and any ref listed in `crew_allowed_workflow_refs` must be protected server-side.

## Crew credentials

Studio never writes a crew credential to state, board, brief, settings, logs or errors, and never prints it. A provider's token reaches only the environment of the crew process, as does the crew's GitHub token. That means crew shell commands can see both tokens in their environment: keep the GitHub token least-privilege, and treat a crew as able to use its model credential while it runs.

The owner config directory, including the `crew-token` file, is denied to crew shell commands and file tools, also when `XDG_CONFIG_HOME` lies outside the home. When a provider returns a `CLAUDE_CONFIG_DIR`, the sandbox allows reading exactly that directory, because the session needs it. The sandbox boundary then does not protect that login from crew shell commands; the guard denies it to the crew's file tools only as a second net. Other logins below the owner config directory stay denied.

The provider is a program the owner configured: it is accepted only from the owner config, as an absolute path to a regular file owned by the current user that neither group nor others can write. It gets a minimal environment, and its output is parsed strictly and never echoed. API billing is off by default, see the README.

Limit detection reads crew logs, which contain untrusted tool output, so it matches only top-level events from Claude Code. A forged event could at worst stop that run and park its label for at most 8 days.
