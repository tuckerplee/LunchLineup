# Custom CI

This directory defines source-neutral validation for LunchLineup on the internal CI appliance.

- `README.md` - documents this directory and its safety boundary.
- `pipeline.json` - declares triggers, worker requirements, validation steps, timeouts, and artifacts.

Only `internal-beta-candidate` enters this 32-stage release-qualification pipeline. Stage zero proves the exact remote candidate, then creates independent job-private `scan` and `build` clones. Every later command executes from one of those clones; scanner mounts are read-only and all generated evidence stays outside source.

The path executes active Semgrep and CodeQL, Terraform, discrete source/unit/integration/browser gates, canonical beta image construction, complete Compose inventory and health, DAST, load, per-image SBOM/Trivy, and a bounded artifact manifest. A root-owned external policy and Ed25519 signer approve the final receipt; candidate code never receives the private key. Qualification retains a transfer bundle but does not contact or power on VM107.

Internal source control is the authoritative trigger for this source-neutral pipeline. GitHub Actions is disabled and is not a release gate. The appliance retains logs and checksum-manifested artifacts for 30 days; the candidate receipt binds its exact internal Git SHA, pipeline contract digest, release-image IDs, interaction proof, and security evidence.
