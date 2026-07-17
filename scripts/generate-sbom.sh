#!/usr/bin/env bash
set -euo pipefail

manifest_path="${1:-.release/release-manifest.json}"
output_dir="${2:-artifacts/sbom}"
: "${RELEASE_REPORT_CERTIFICATE_IDENTITY:?Set the trusted GitHub Actions workflow certificate identity.}"
: "${RELEASE_REPORT_OIDC_ISSUER:?Set the trusted Sigstore OIDC issuer.}"

for command in syft cosign; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to generate authenticated release-image SBOMs." >&2
    exit 1
  fi
done
test -f "$manifest_path"
mkdir -p "$output_dir"

while IFS= read -r service; do
  image_json="$(node scripts/production-image-inventory.mjs --manifest "$manifest_path" --service "$service")"
  image_ref="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).ref)' "$image_json")"
  registry_attestation_required="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).registryAttestationRequired))' "$image_json")"
  report_path="$output_dir/$service.spdx.json"
  evidence_path="$output_dir/$service.sbom-evidence.json"
  signature_path="$output_dir/$service.sbom-evidence.sigstore.json"

  syft "$image_ref" -o "spdx-json=$report_path"
  node scripts/write-release-image-report-evidence.mjs \
    --kind sbom \
    --service "$service" \
    --manifest "$manifest_path" \
    --report "$report_path" \
    --output "$evidence_path" \
    --certificate-identity "$RELEASE_REPORT_CERTIFICATE_IDENTITY" \
    --oidc-issuer "$RELEASE_REPORT_OIDC_ISSUER"

  cosign sign-blob --yes --bundle "$signature_path" "$evidence_path"
  if [ "$registry_attestation_required" = true ]; then
    cosign attest --yes --type custom --predicate "$evidence_path" "$image_ref"
  fi
done < <(node scripts/production-image-inventory.mjs --manifest "$manifest_path" --list)

node scripts/verify-sbom-release-reports.mjs "$manifest_path" "$output_dir" \
  --expected-certificate-identity "$RELEASE_REPORT_CERTIFICATE_IDENTITY" \
  --expected-oidc-issuer "$RELEASE_REPORT_OIDC_ISSUER"
