# GitHub Automation

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `workflows/`: retained, pinned GitHub Actions definitions for review and rollback reference.

## Live CI Boundary

`.ci/pipeline.json` remains the source-neutral internal-appliance validation path. GitHub coordinates check status, security uploads, immutable release artifacts, and protected release gates, but every `.github/workflows/ci.yml` job executes on the repository-scoped ProxmoxZ runner selected by `[self-hosted, linux, x64, proxmoxz, ci]`; no GitHub-hosted runner is eligible.

LunchLineup is public, so the self-hosted workflow does not subscribe to `pull_request` events. Trusted pushes to `main`, `develop`, and `internal-beta-candidate`, the bounded schedule, and explicit operator dispatches are the only triggers; arbitrary fork code must never execute on the local appliance.

A push to `internal-beta-candidate`, or a manual branch dispatch with `internal_beta_candidate=true`, builds and pushes SHA-tagged images, verifies the exact manifest, runs the complete source/security/integration/browser/release-image/DAST/load/SBOM/Trivy chain, and uploads `internal-beta-candidate-proof-<sha>`. That proof is candidate evidence only: it never deploys, restarts, or targets the production environment. Main-only staging and production conditions remain unchanged.

Scheduled Dependabot configuration is deliberately absent, so GitHub cannot launch dependency-update jobs or send their failure notifications. Dependency updates are deliberate source changes and must pass the internal pipeline before promotion.

The workflow token defaults to read-only repository contents. Jobs receive write permissions only for their bounded responsibility.
