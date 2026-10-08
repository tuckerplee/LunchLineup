# Source-neutral production release trust

This is a source contract, not signer approval, installation approval, runtime qualification or permission to publish. C16 installation/activation remains deferred. Generic CI and GitHub Actions remain disabled. Historical GitHub/VM217 deployment choreography is not converted into an authorized controller by this change.

The existing release registry commands and `materialize-rollback-state.mjs` accept `--production-trust`. Explicitly production-declared states and indexes reject omission of this mode, including standalone blob verification; target-absent legacy artifacts retain their old contract. This opts into the fixed external policy `/etc/lunchlineup/production-release-trust.json`; there is no candidate-selected policy path, digest, key or approval flag. The expected certificate identity and OIDC issuer arguments must exactly match that policy. Existing calls without this option preserve the legacy GitHub-workflow Sigstore contract and are not evidence of approved source-neutral production trust. An installed production controller MUST always select this option and pin reviewed validator bytes; allowing candidates to omit it defeats that controller boundary.

The external production trust owner must independently approve and install the policy, its ancestor directories and the Cosign verifier. Every path component must be root-owned, nonsymlink and not writable by group/others. Policy version 1 has these fields:

- `kind`: `lunchlineup-production-release-trust`.
- `releaseTarget`: `production`.
- `scheme`: `sigstore-keyless-cosign-v1`.
- `certificateIdentity`: exact approved HTTPS certificate identity; no credentials, query or fragment.
- `oidcIssuer`: exact approved HTTPS issuer; no credentials, query or fragment.
- `sourceShas`: nonempty unique list of full lowercase 40-character SHAs, maximum 128. Include independently approved retained rollback sources when needed; omission fails closed.
- `notBefore`, `expiresAt`: exact UTC timestamps with millisecond precision, e.g. `2026-10-08T00:00:00.000Z`. These are validity boundaries, not suggested approval dates.
- `maxIndexAgeSeconds`: positive safe integer limiting signed-index age. Retained rollback indexes also expire. Choose a reviewed age bound consistent with rollback retention; subsequent reuse requires independent external policy reapproval of that source and age bound. Never overwrite or restamp the immutable index at its source-addressed key.
- `cosignPath`, `cosignSha256`: protected absolute nonsymlink verifier path and lowercase SHA-256 of that exact executable. The executable must be a single-link executable regular file no larger than 512 MiB; hashing streams through a 1 MiB buffer and checks file identity/change metadata. Production mode ignores candidate Cosign environment overrides and uses a minimal verifier environment with a private HOME and a 60-second timeout.

No sample approved identity, source, executable hash or active policy is shipped. Policy existence alone is not independently reviewed approval: its deployment/change process and installed controller hash remain required external evidence. Candidate processes must have no root/policy-write authority. Run verification using a protected installed controller and validator, outside candidate-controlled code and environment; never run a candidate checkout as the trusted production verifier.

Production release bundle state retains version 2 and must explicitly set `releaseManifest.releaseTarget` to `production`. Internal-beta manifests are rejected. Newly created production registry indexes retain the existing version-3 Sigstore index and add `releaseTarget: production` and `issuedAt`; both fields are covered by the signed index bytes. Every verification checks exact target/source against external policy, policy time bounds and signed-index freshness. Existing immutable bundle checksum/path binding and Cosign verification remain in effect. A bundle state is authenticated together with its signed index; its independent blob verification is not a substitute for complete `verifyReleaseAuthenticity` verification.

This change does not sign artifacts, approve a signer, publish a registry object, install policy, update a current pointer, or modify the legacy deployment validator. The full manifest/publishing bridge, digest-pinned registry readbacks, controller installation, actual approved signer and external trust-root qualification remain outstanding. The existing Cosign trust implementation is retained; external owners must qualify issuer support and trust-root distribution before use.

Test Agent qualification request: exercise missing/unprotected/symlink policy, unapproved source or target, beta substitution, wrong identity/issuer, expired/future policy, stale/future signed index, verifier path/hash mismatch, changed state/index/signature bytes, and environment override rejection. Also retain existing legacy Sigstore snapshot-race and registry publication/rollback cases. No tests were executed by the implementation lead.


## Authenticated-byte ownership

The authenticity helper retains one private snapshot set through a synchronous
consumer callback for publication and repointing. All four upload/readback inputs
(state, index and both signatures) come from that authenticated set. Bootstrap
source/live-proof checks consume that same state. The callback must complete all
work before returning; asynchronous functions and Promise/thenable results are
rejected. It must never schedule delayed work using snapshot paths.

Rollback materialization consumes the returned authenticated state and original
authenticated state bytes for secret-field checks, never a second candidate-path
read. Pointer parsing/comparison consumes authenticated blob bytes. Registry
resolution downloads into private owned scratch, then delivers only verified
state/index/signature bytes to caller-selected output destinations. Repointing
re-verifies the retained set and holds those snapshots through pointer updates.
Delivered output files must be authenticated again by subsequent consumers;
their location is not an enduring integrity guarantee.

The installed owner and verifier UID are trusted. Private directories exclude
candidate writers running under separate identities; they are not protection
against a compromised verifier or a hostile process sharing the trusted UID.

Test Agent must add deterministic original-input replacement during the Cosign
wait for materialization and publication, replacement during publication/readback,
and pointer/bootstrap/resolve/repoint races. Assert only authenticated source,
target and bytes are consumed, immutable objects cannot be poisoned, no false
pointer advancement occurs, and owned scratch is removed on success/refusal.
No race fixture or execution was performed by this source correction.
