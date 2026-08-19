# Security Automation

The source-neutral `.ci/pipeline.json` runs on the internal CI appliance. The active GitHub workflow adds review security analysis, immutable release images, and protected release gates. A push to `internal-beta-candidate`, or an explicit `internal_beta_candidate=true` workflow dispatch from a branch, must complete the entire release chain and emit an exact-SHA candidate proof before the beta is eligible to deploy.

The GitHub workflow defines two independent source scanners:

- Semgrep runs from a versioned, digest-pinned container, writes SARIF, uploads it through the SHA-pinned GitHub CodeQL upload action, and then enforces the scanner exit code.
- CodeQL runs `security-extended` analysis for JavaScript/TypeScript and Python, waits for GitHub to process each upload, and fails the job if extraction, analysis, or upload fails.

Both jobs have only `contents: read`, plus `security-events: write` for result upload. CodeQL also has `actions: read` for workflow metadata. The workflow default is `contents: read`; release jobs declare any additional write permissions locally.

The unit and release chain requires Semgrep, CodeQL, and the production dependency audit. Its pull-request path also rejects newly introduced high or critical vulnerable dependencies. Semgrep runs as the GitHub runner UID with a writable container-only home, keeping SARIF writable without granting root or weakening findings.

## Dependency Updates

`.github/dependabot.yml` is intentionally absent. This prevents GitHub from launching scheduled dependency-update jobs or sending their failure notifications. Operators prepare dependency updates as ordinary source changes and push them to internal source control for validation.

The exact production npm audit remains the installed-tree launch gate. Internal CI validates the locked dependency tree, tests, and build; dependency advisories must be reviewed before any deployment.

## GitHub Controls

Verify outside the repository that:

- GitHub Actions is enabled and allowed to publish packages and security events for this pinned workflow.
- The protected `internal-beta-candidate` branch requires `Internal Beta: Exact Candidate Launch Proof` and the non-artifact review checks before update.
- Repository variables define the full `INTERNAL_BETA_*` public build contract; the workflow requires the canonical `beta.lunchlineup.com` origin and health URL, same-origin `/api/v2`, production browser safeguards, monitored contacts, and exact `closed_beta` signup until counsel-approved, versioned Terms permit a policy change.
- No scheduled Dependabot configuration exists.
- Secret scanning and push protection remain enabled, and every reported secret alert is reviewed by an authorized operator.

Internal CI does not dismiss GitHub alerts or modify repository security settings.
