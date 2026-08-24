# Internal Beta Local-CI Runbook

## Qualification boundary

Only `refs/heads/internal-beta-candidate` enters `.ci/pipeline.json`. The first stage verifies the exact remote SHA, a clean original checkout, `origin/main` ancestry, the pipeline digest, and independent Git object stores. It writes a retained source proof plus job-private scan and build clones. The source context stays under `RUNNER_TEMP` and is never uploaded.

Semgrep and CodeQL use the read-only scan clone. Dependency, source, test, integration, and image commands use the build clone. Terraform state, virtual environments, databases, browser output, Compose state, scanner databases, and image archives remain outside both clones. The 29 exact gate receipts must all bind the same SHA, tree, baseline, run, attempt, source proof, pipeline digest, and artifact inventory.

## Signing and retention

The approved pipeline digest and exact gate list live in `/etc/custom-ci/policies/lunchlineup-internal-beta.json` on VM218. `/usr/local/libexec/custom-ci/lunchlineup-sign-receipt` revalidates the unsigned receipt and signs its exact bytes with the root-owned Ed25519 key. The CI worker may invoke the helper but cannot read `/etc/custom-ci/keys/lunchlineup-beta-ed25519.pem`. The pipeline immediately verifies the detached signature with the public key.

The retained transfer bundle contains only the receipt, detached signature, release manifest, artifact manifest, and exact compressed image archives. It never contains source clones, Node modules, runtime environments, CI credentials, databases, provider secrets, or internal absolute paths. Qualification stops after retaining this bundle; it does not contact or power on VM107.

## VM107 launch

Install the public key and approved policy out of band at `/etc/lunchlineup/trust/`, and install the shared verifier root-owned at `/usr/local/libexec/lunchlineup/`. Materialize one bundle under `/opt/lunchlineup-release` with root ownership and no group/world writes. Provision the real beta runtime environment separately; Resend and other provider secrets never travel in the bundle.

Set `BETA_CANDIDATE_SHA` to the exact candidate and run `scripts/internal-beta-lifecycle.sh launch`. The lifecycle verifies the signed receipt before source checks, image loading, Resend, migrations, or Compose. Every archive hash and byte count is checked, every loaded image ID must match the release manifest, conflicting tags fail, VM-side builds are forbidden, and Compose uses `--no-build --pull never`.

Readiness is complete only when `/var/lib/lunchlineup/proofs/internal-beta-readiness.json` records the receipt, signature key ID, release and artifact manifest digests, artifact root digest, pipeline digest, exact image-ID match, and receipt validity along with application, migration, monitoring, outbox, provider, and backup/restore proof.

## Pause

Run `scripts/internal-beta-lifecycle.sh pause` with the deployed source SHA. Pause remains source-bound but does not require a fresh receipt. It stops only the LunchLineup Compose project, preserves volumes and proofs, and does not change VM power or onboot policy.
