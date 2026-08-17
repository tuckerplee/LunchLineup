# GitHub Automation (Disabled)

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `workflows/`: retained, pinned GitHub Actions definitions for review and rollback reference.

## Live CI Boundary

Repository-level GitHub Actions is disabled. The authoritative source validation path is `.ci/pipeline.json` on the internal CI appliance, triggered by pushes to internal source control.

Scheduled Dependabot configuration is deliberately absent, so GitHub cannot launch dependency-update jobs or send their failure notifications. Dependency updates are deliberate source changes and must pass the internal pipeline before promotion.

If the retained workflows are ever reviewed for reactivation, their token defaults to read-only repository contents. Jobs receive write permissions only for their bounded responsibility.
