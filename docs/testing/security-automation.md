# Security Automation

LunchLineup uses two independent source scanners in the required CI path:

- Semgrep runs from a versioned, digest-pinned container, writes SARIF, uploads it through the SHA-pinned GitHub CodeQL upload action, and then enforces the scanner exit code.
- CodeQL runs `security-extended` analysis for JavaScript/TypeScript and Python, waits for GitHub to process each upload, and fails the job if extraction, analysis, or upload fails.

Both jobs have only `contents: read`, plus `security-events: write` for result upload. CodeQL also has `actions: read` for workflow metadata. The workflow default is `contents: read`; release jobs declare any additional write permissions locally.

The unit and release chain requires Semgrep, CodeQL, and the production dependency audit. Pull requests also run GitHub dependency review and reject newly introduced high or critical vulnerable dependencies. Weekly scheduled CI refreshes analysis even when application code is unchanged.

## Dependency Updates

`.github/dependabot.yml` checks the root npm workspace, both Python applications, GitHub Actions, Docker Compose, and application Dockerfiles each Monday. Updates remain review-only. The configuration intentionally omits `target-branch` so security updates continue to target the repository default branch.

The exact production npm audit remains the installed-tree launch gate. Dependabot alert counts describe the current default branch dependency graph and are not dismissed by this automation; merging a patched branch and completing a new default-branch dependency graph refresh is required to close stale alerts.

## Required GitHub Controls

Before launch, verify outside the repository that:

- Code scanning accepts successful Semgrep and both CodeQL categories on `main`.
- Branch protection requires the SAST, CodeQL, dependency audit, and test jobs.
- Dependabot alerts and security updates remain enabled.
- Secret scanning and push protection remain enabled, and every reported secret alert is reviewed by an authorized operator.
- Workflow permissions remain read-only by default in repository settings.

Repository automation does not dismiss alerts or modify these settings.