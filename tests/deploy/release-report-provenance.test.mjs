import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

function jobBlock(workflow, name, nextName = null) {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start) : workflow.length;
  assert.ok(start >= 0 && end > start, `missing ${name} workflow block`);
  return workflow.slice(start, end);
}

test('Compose-derived release reports are signed, first-party-attested, reverified, and archived immutably', () => {
  const ci = read('.github/workflows/ci.yml');
  const aggregate = jobBlock(ci, 'validate-release-gates', 'deploy-staging');
  const sbom = jobBlock(ci, 'sbom', 'trivy-scan');
  const trivy = jobBlock(ci, 'trivy-scan');

  for (const [name, block] of [['SBOM', sbom], ['Trivy', trivy]]) {
    assert.match(block, /permissions:\s*\n\s+contents: read\s*\n\s+id-token: write\s*\n\s+packages: write/);
    assert.match(block, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
    assert.match(block, /cosign sign-blob --yes --bundle/);
    assert.match(block, /cosign attest --yes --type custom --predicate "\$evidence" "\$IMAGE_REF"/);
    assert.match(block, /if \[ "\$REGISTRY_ATTESTATION_REQUIRED" = true \]; then/);
    assert.match(block, /production-image-inventory\.mjs/);
    assert.match(block, /write-release-image-report-evidence\.mjs/);
    assert.match(block, /--expected-certificate-identity "\$RELEASE_BUNDLE_CERTIFICATE_IDENTITY"/);
    assert.match(block, /--expected-oidc-issuer "\$RELEASE_BUNDLE_OIDC_ISSUER"/);
    assert.match(block, /retention-days: 90/);
    assert.ok(block.indexOf('cosign attest') < block.indexOf('actions/upload-artifact@'), `${name} attestation must precede upload`);
  }

  assert.match(trivy, /needs: \[build-images, sbom, production-image-inventory\]/);
  assert.match(ci, /production-image-inventory:[\s\S]*--github-matrix-output "\$GITHUB_OUTPUT"/);
  assert.equal((ci.match(/fromJSON\(needs\.production-image-inventory\.outputs\.matrix\)/g) ?? []).length, 2);
  assert.match(aggregate, /permissions:\s*\n\s+contents: write\s*\n\s+packages: read/);
  assert.match(aggregate, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.match(aggregate, /docker\/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9/);
  assert.match(aggregate, /Verify signed digest-pinned Trivy release reports/);
  assert.match(aggregate, /Verify signed digest-pinned release SBOMs/);
  assert.match(aggregate, /Publish immutable release evidence/);
  assert.match(aggregate, /node scripts\/publish-release-evidence\.mjs/);
  assert.doesNotMatch(`${sbom}\n${trivy}`, /retention-days: (?:[1-9]|[1-8][0-9])\b/);
});

test('standalone SBOM generation fails closed without Sigstore provenance', () => {
  const generator = read('scripts/generate-sbom.sh');
  const publisher = read('scripts/publish-release-evidence.mjs');
  const verifier = read('scripts/verify-sbom-release-reports.mjs');
  const trivyVerifier = read('scripts/verify-trivy-release-reports.mjs');
  const provenance = read('scripts/signed-report-provenance.mjs');

  assert.match(generator, /RELEASE_REPORT_CERTIFICATE_IDENTITY:\?/);
  assert.match(generator, /RELEASE_REPORT_OIDC_ISSUER:\?/);
  assert.match(generator, /for command in syft cosign/);
  assert.match(generator, /cosign sign-blob --yes --bundle/);
  assert.match(generator, /cosign attest --yes --type custom --predicate/);
  assert.match(generator, /production-image-inventory\.mjs/);
  assert.match(generator, /registry_attestation_required/);
  for (const source of [verifier, trivyVerifier]) {
    assert.match(source, /expected certificate identity and OIDC issuer are required/);
    assert.match(source, /verifySignedReportProvenance/);
  }
  assert.match(provenance, /verify-attestation/);
  assert.match(provenance, /if \(!registryAttestationRequired\) return/);
  assert.match(provenance, /No trusted registry attestation binds the exact report evidence to the release image digest/);
  assert.match(publisher, /Repository immutable releases must be enabled/);
  assert.match(publisher, /validateImmutableRelease/);
});
