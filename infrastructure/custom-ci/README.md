# Custom CI Appliance Assets

- `README.md`: indexes reviewed files installed outside candidate-controlled workspaces.
- `lunchlineup-sign-receipt`: fixed-path root wrapper allowed by the appliance privilege policy.
- `lunchlineup-sign-receipt.mjs`: external-policy receipt validator and Ed25519 detached-signature owner.
- `lunchlineup-internal-beta.policy.json`: reviewed policy template whose pipeline digest must exact-match the installed pipeline bytes.

Install these files root-owned under `/usr/local/libexec/custom-ci/`. The external policy and keys remain under `/etc/custom-ci/`; no private key belongs in this directory or repository.
