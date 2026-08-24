# GitHub Automation

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `workflows/`: intentionally contains documentation only; no executable workflow files are retained here.

## Live CI Boundary

`.ci/pipeline.json` is the authoritative CI contract and runs through the internal CI appliance and its internal Git remote. Repository-level GitHub Actions is disabled. The historical workflow is retained at `docs/legacy/github-actions-ci.yml`, outside GitHub's executable workflow directory. GitHub is a source mirror only and is not part of the live CI execution path.

LunchLineup is public, so GitHub-hosted events must not execute repository code on local infrastructure. Pushes to the internal `ci` Git remote are validated and queued by the internal appliance.

Scheduled Dependabot configuration is deliberately absent, so GitHub cannot launch dependency-update jobs or send their failure notifications. Dependency updates are deliberate source changes and must pass the internal pipeline before promotion.
