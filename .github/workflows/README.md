# GitHub Workflows

## Files

- `README.md`: this workflow folder guide and the only file permitted in this directory.

Repository-level GitHub Actions is disabled. The authoritative pipeline is `.ci/pipeline.json`, executed by the internal CI appliance from its internal Git repository. The former workflow is historical review material at `docs/legacy/github-actions-ci.yml`; keeping it outside this directory prevents an accidental Actions re-enable from scheduling runs or sending CI failure email.
