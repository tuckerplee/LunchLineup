# Custom CI

This directory defines source-neutral validation for LunchLineup on the internal CI appliance.

- `README.md` - documents this directory and its safety boundary.
- `pipeline.json` - declares triggers, worker requirements, validation steps, timeouts, and artifacts.

The internal-beta candidate path executes source validation, active Semgrep SAST, disposable PostgreSQL/Redis/RabbitMQ integration, exact-SHA release-image builds, DB-backed browser workflows, interaction proof, DAST, load qualification, SBOM, Trivy, and a checksum-bound candidate receipt. Its containers and generated data are job-private and disposable; it never deploys, restarts, seeds, or connects to the live LunchLineup service.

Internal source control is the authoritative trigger for this source-neutral pipeline. GitHub Actions is disabled and is not a release gate. The appliance retains logs and checksum-manifested artifacts for 30 days; the candidate receipt binds its exact internal Git SHA, pipeline contract digest, release-image IDs, interaction proof, and security evidence.
