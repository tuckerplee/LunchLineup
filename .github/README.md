# GitHub Automation

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `workflows/`: retained, pinned GitHub Actions definitions for review and rollback reference.

## Live CI Boundary

`.ci/pipeline.json` is the authoritative CI contract and runs through the internal CI appliance and its internal Git remote. Repository-level GitHub Actions is disabled. The workflow definitions below are retained only for review and rollback reference; GitHub is not part of the live CI execution path.

LunchLineup is public, so GitHub-hosted events must not execute repository code on local infrastructure. Pushes to the internal `ci` Git remote are validated and queued by the internal appliance.

If GitHub orchestration is explicitly restored, a push to `internal-beta-candidate`, or a manual branch dispatch with `internal_beta_candidate=true`, can build and verify the legacy exact-SHA candidate proof. While Actions remains disabled, this path produces no live evidence and is not a launch gate.

Scheduled Dependabot configuration is deliberately absent, so GitHub cannot launch dependency-update jobs or send their failure notifications. Dependency updates are deliberate source changes and must pass the internal pipeline before promotion.

The workflow token defaults to read-only repository contents. Jobs receive write permissions only for their bounded responsibility.
