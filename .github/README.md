# GitHub Automation

## Files

- `README.md`: this GitHub automation map.
- `codeql/`: CodeQL query and source-scope configuration.
- `dependabot.yml`: weekly npm, Python, GitHub Actions, and container dependency update policy.
- `workflows/`: pinned GitHub Actions CI, security, release, deploy, and rollback automation.

## Security Boundary

The workflow token defaults to read-only repository contents. Jobs receive write permissions only for their bounded responsibility, such as uploading code-scanning results, publishing release images, or creating immutable release evidence.

Dependabot opens reviewable updates; it does not auto-merge, dismiss alerts, or alter repository security settings.