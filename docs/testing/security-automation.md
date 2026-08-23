# Security Automation

The authoritative CI path is the source-neutral `.ci/pipeline.json` executed by the internal CI appliance from its internal Git repository. Repository-level GitHub Actions is disabled. The GitHub workflow definitions and the controls below are retained for review and rollback reference; they are not a live execution dependency. A push to the internal `ci` remote must pass the local pipeline for the exact candidate SHA before the beta is eligible to deploy.

The GitHub workflow defines two independent source scanners:

- Semgrep runs from a versioned, digest-pinned container, compares the candidate against the fetched `origin/main` baseline, writes only newly introduced findings to SARIF, uploads them through the SHA-pinned GitHub CodeQL upload action, and then enforces the scanner exit code. Existing findings remain visible in GitHub code scanning and are not silently dismissed; every new finding blocks the candidate until fixed or explicitly reviewed outside CI.
- CodeQL runs `security-extended` analysis for JavaScript/TypeScript and Python, waits for GitHub to process each upload, and fails the job if extraction, analysis, or upload fails.

Both jobs have only `contents: read`, plus `security-events: write` for result upload. CodeQL also has `actions: read` for workflow metadata. The workflow default is `contents: read`; release jobs declare any additional write permissions locally.

The unit and release chain requires Semgrep, CodeQL, and the production dependency audit. Semgrep runs as the local runner UID with a writable container-only home, keeping SARIF writable without granting root or weakening findings. The SAST checkout fetches full history so `origin/main` is an auditable baseline rather than a mutable local snapshot.

## Dependency Updates

`.github/dependabot.yml` is intentionally absent. This prevents GitHub from launching scheduled dependency-update jobs or sending their failure notifications. Operators prepare dependency updates as ordinary source changes and push them to internal source control for validation.

The exact production npm audit remains the installed-tree launch gate. Internal CI validates the locked dependency tree, tests, and build; dependency advisories must be reviewed before any deployment.

## GitHub Controls

Verify outside the repository that:

- GitHub Actions remains disabled; restoring it requires an explicit operational decision and a review of every external action and credential boundary below.
- GitHub branch protection does not require checks from the disabled workflow; candidate acceptance is recorded by the internal CI appliance instead.
- Repository variables define the full `INTERNAL_BETA_*` public build contract; the workflow requires the canonical `beta.lunchlineup.com` origin and health URL, same-origin `/api/v2`, production browser safeguards, monitored contacts, and exact `closed_beta` signup until counsel-approved, versioned Terms permit a policy change.
- No scheduled Dependabot configuration exists.
- Secret scanning and push protection remain enabled, and every reported secret alert is reviewed by an authorized operator.

Internal CI does not dismiss GitHub alerts or modify repository security settings.
