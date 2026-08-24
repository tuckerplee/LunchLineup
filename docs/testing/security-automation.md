# Security Automation

The authoritative CI path is the source-neutral `.ci/pipeline.json` executed by the internal CI appliance from its internal Git repository. Repository-level GitHub Actions is disabled, and `.github/workflows/` contains no executable YAML. The former workflow is retained at `docs/legacy/github-actions-ci.yml` for historical review only. A push to the internal `ci` remote must pass the local pipeline for the exact candidate SHA before the beta is eligible to deploy; GitHub is a source mirror only.

The retained GitHub workflow documents the former GitHub-only source scanners. Live Semgrep and both CodeQL languages execute on the internal appliance from the isolated scan clone; GitHub SARIF and CodeQL uploads are not part of candidate acceptance.

- Internal Semgrep runs from a versioned, digest-pinned container, scans the complete candidate, compares it with the fetched `origin/main` baseline, retains both SARIF reports, and enforces each scanner result locally.
- Internal CodeQL runs `security-extended` analysis for JavaScript/TypeScript and Python, retains the SARIF reports, and fails qualification if extraction or analysis fails.

The historical GitHub permissions and uploads are documentation only and produce no release evidence.

The unit and release chain requires Semgrep, CodeQL, and the production dependency audit. Semgrep receives a read-only scan clone and a dedicated writable output directory. CodeQL databases live under `RUNNER_TEMP`, use the reviewed bundle digest, and reject findings outside the checked-in expiring baseline. The scan clone contains the exact retained `origin/main` object used by both delta policies.

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
