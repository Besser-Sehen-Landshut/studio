# Security policy

Please report vulnerabilities through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

## Security model

The crew guard is a convenience layer, not a security boundary. The boundary is the sandbox, a least-privilege token and server-side branch protection. `main` and any ref listed in `crew_allowed_workflow_refs` must be protected server-side.
