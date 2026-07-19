import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { deriveProductionImageInventory } from '../../scripts/production-image-inventory.mjs';
import { buildReleaseImageReportEvidence } from '../../scripts/write-release-image-report-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const fakeCosign = join(root, 'tests/deploy/fake-cosign-release-report.mjs');
const releaseServices = ['api', 'api-v2', 'web', 'engine', 'worker', 'migrate', 'control', 'backup'];
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const certificateIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const oidcIssuer = 'https://token.actions.githubusercontent.com';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('SBOM verifier requires trusted signatures and exact release-image attestations', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-sbom-release-'));
  const reportsDir = join(scratch, 'reports');
  const manifestPath = join(scratch, 'release-manifest.json');
  const images = Object.fromEntries(releaseServices.map((service, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    return [service, {
      ref: `ghcr.io/tuckerplee/lunchlineup/${service}:${sourceSha}@${digest}`,
      digest,
    }];
  }));
  const manifestText = `${JSON.stringify({ version: 1, sourceSha, images }, null, 2)}\n`;
  let inventory;

  function writeSignatureBundle(service, valid = true) {
    const evidencePath = join(reportsDir, `${service}.sbom-evidence.json`);
    writeFileSync(join(reportsDir, `${service}.sbom-evidence.sigstore.json`), `${JSON.stringify({
      valid,
      artifactSha256: sha256(readFileSync(evidencePath)),
      certificateIdentity,
      oidcIssuer,
    })}\n`);
  }

  function writeReport(service, packages = [{ SPDXID: `SPDXRef-Package-${service}`, name: service, versionInfo: sourceSha }]) {
    const image = inventory.images.find(({ name }) => name === service);
    assert.ok(image, `missing production image ${service}`);
    const reportFile = `${service}.spdx.json`;
    const reportText = `${JSON.stringify({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `lunchlineup-${service}`,
      documentNamespace: `https://lunchlineup.com/sbom/${sourceSha}/${service}`,
      creationInfo: { creators: ['Tool: syft-1.42.1'] },
      packages,
    }, null, 2)}\n`;
    writeFileSync(join(reportsDir, reportFile), reportText);
    const evidence = buildReleaseImageReportEvidence({
      kind: 'sbom',
      image,
      manifest: JSON.parse(manifestText),
      manifestBytes: Buffer.from(manifestText),
      reportPath: reportFile,
      reportBytes: Buffer.from(reportText),
      certificateIdentity,
      oidcIssuer,
    });
    writeFileSync(join(reportsDir, `${service}.sbom-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    writeSignatureBundle(service);
  }

  const run = (environment = {}, identity = certificateIdentity) => spawnSync(
    process.execPath,
    [
      'scripts/verify-sbom-release-reports.mjs',
      manifestPath,
      reportsDir,
      '--expected-certificate-identity', identity,
      '--expected-oidc-issuer', oidcIssuer,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        COSIGN_BINARY: process.execPath,
        COSIGN_ARGUMENT_PREFIX_JSON: JSON.stringify([fakeCosign]),
        FAKE_REPORTS_DIR: reportsDir,
        FAKE_REPORT_KIND: 'sbom',
        FAKE_SIGNER_IDENTITY: certificateIdentity,
        FAKE_SIGNER_ISSUER: oidcIssuer,
        ...environment,
      },
    },
  );

  try {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(manifestPath, manifestText);
    inventory = deriveProductionImageInventory({ manifestPath });
    for (const { name } of inventory.images) writeReport(name);

    const valid = run();
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, new RegExp(`images=${inventory.images.map(({ name }) => name).join(',')}`));

    writeSignatureBundle('proxy', false);
    const unsignedThirdParty = run();
    assert.notEqual(unsignedThirdParty.status, 0);
    assert.match(unsignedThirdParty.stderr, /Cosign rejected release report evidence signature/);
    writeSignatureBundle('proxy');

    writeSignatureBundle('api', false);
    const unsigned = run();
    assert.notEqual(unsigned.status, 0);
    assert.match(unsigned.stderr, /Cosign rejected release report evidence signature/);
    writeSignatureBundle('api');

    const wrongSubject = run({ FAKE_ATTESTATION_FAILURE: 'subject' });
    assert.notEqual(wrongSubject.status, 0);
    assert.match(wrongSubject.stderr, /No trusted registry attestation binds/);

    const wrongPredicate = run({ FAKE_ATTESTATION_FAILURE: 'predicate' });
    assert.notEqual(wrongPredicate.status, 0);
    assert.match(wrongPredicate.stderr, /No trusted registry attestation binds/);

    const wrongSigner = run({}, 'https://github.com/tuckerplee/other/.github/workflows/ci.yml@refs/heads/main');
    assert.notEqual(wrongSigner.status, 0);
    assert.match(wrongSigner.stderr, /provenance does not match/);

    const evidencePath = join(reportsDir, 'api.sbom-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, imageDigest: 'sha256:' + '0'.repeat(64) })}\n`);
    const detached = run();
    assert.notEqual(detached.status, 0);
    assert.match(detached.stderr, /imageDigest does not match/);
    writeReport('api');

    writeReport('worker', []);
    const empty = run();
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /must contain at least one package/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
