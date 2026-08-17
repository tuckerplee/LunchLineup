# Security Automation

The authoritative CI path is the source-neutral `.ci/pipeline.json` executed by the internal CI appliance. Repository-level GitHub Actions is disabled. The GitHub workflow definitions and the controls below are retained for review and rollback reference; they are not a live execution dependency.

The retained workflow defines two independent source scanners:

- Semgrep runs from a versioned, digest-pinned container, writes SARIF, uploads it through the SHA-pinned GitHub CodeQL upload action, and then enforces the scanner exit code.
- CodeQL runs `security-extended` analysis for JavaScript/TypeScript and Python, waits for GitHub to process each upload, and fails the job if extraction, analysis, or upload fails.

Both jobs have only `contents: read`, plus `security-events: write` for result upload. CodeQL also has `actions: read` for workflow metadata. The workflow default is `contents: read`; release jobs declare any additional write permissions locally.

If reactivated, the retained unit and release chain requires Semgrep, CodeQL, and the production dependency audit. Its pull-request path also rejects newly introduced high or critical vulnerable dependencies.

## Dependency Updates

`.github/dependabot.yml` is intentionally absent. This prevents GitHub from launching scheduled dependency-update jobs or sending their failure notifications. Operators prepare dependency updates as ordinary source changes and push them to internal source control for validation.

The exact production npm audit remains the installed-tree launch gate. Internal CI validates the locked dependency tree, tests, and build; dependency advisories must be reviewed before any deployment.

## GitHub Controls

While GitHub remains a mirror, verify outside the repository that:

- Repository-level GitHub Actions remains disabled.
- No scheduled Dependabot configuration exists.
- Secret scanning and push protection remain enabled, and every reported secret alert is reviewed by an authorized operator.

Internal CI does not dismiss GitHub alerts or modify repository security settings.
