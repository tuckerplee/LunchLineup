# GitHub Automation

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `workflows/`: retained, pinned GitHub Actions definitions for review and rollback reference.

## Live CI Boundary

`.ci/pipeline.json` remains the source-neutral internal-appliance validation path. `.github/workflows/ci.yml` is also active for GitHub review, security, immutable release artifacts, and protected release gates.

A push to `internal-beta-candidate`, or a manual branch dispatch with `internal_beta_candidate=true`, builds and pushes SHA-tagged images, verifies the exact manifest, runs the complete source/security/integration/browser/release-image/DAST/load/SBOM/Trivy chain, and uploads `internal-beta-candidate-proof-<sha>`. That proof is candidate evidence only: it never deploys, restarts, or targets the production environment. Main-only staging and production conditions remain unchanged.

Scheduled Dependabot configuration is deliberately absent, so GitHub cannot launch dependency-update jobs or send their failure notifications. Dependency updates are deliberate source changes and must pass the internal pipeline before promotion.

The workflow token defaults to read-only repository contents. Jobs receive write permissions only for their bounded responsibility.
