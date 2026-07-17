#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveProductionImageInventory } from './production-image-inventory.mjs';
import { verifySignedReportProvenance } from './signed-report-provenance.mjs';
import { buildReleaseImageReportEvidence } from './write-release-image-report-evidence.mjs';

function fail(message) {
  console.error(`SBOM release report verification failed: ${message}`);
  process.exit(1);
}

function readBytes(path, label) {
  try {
    return readFileSync(path);
  } catch (error) {
    fail(`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(path, label) {
  const bytes = readBytes(path, label);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    fail(`${label} ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/verify-sbom-release-reports.mjs <release-manifest.json> <reports-dir> [--service NAME] --expected-certificate-identity ID --expected-oidc-issuer URL');
    process.exit(0);
  }
  const manifestPath = argv[0];
  const reportsDir = argv[1];
  let service = null;
  let certificateIdentity = null;
  let oidcIssuer = null;
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--service') service = value;
    else if (argv[index] === '--expected-certificate-identity') certificateIdentity = value;
    else if (argv[index] === '--expected-oidc-issuer') oidcIssuer = value;
    else fail(`unsupported argument: ${argv[index]}`);
    index += 1;
  }
  if (!manifestPath || !reportsDir) fail('release manifest and reports directory are required.');
  if (!certificateIdentity || !oidcIssuer) fail('expected certificate identity and OIDC issuer are required.');
  return {
    manifestPath: resolve(manifestPath),
    reportsDir: resolve(reportsDir),
    service,
    certificateIdentity,
    oidcIssuer,
  };
}

function verifyImage(manifest, manifestBytes, reportsDir, image, options) {
  const service = image.name;
  const reportName = `${service}.spdx.json`;
  const evidenceName = `${service}.sbom-evidence.json`;
  const signatureName = `${service}.sbom-evidence.sigstore.json`;
  const report = readJson(join(reportsDir, reportName), `${service} SBOM report`);
  const evidence = readJson(join(reportsDir, evidenceName), `${service} SBOM evidence`).value;

  const expectedEvidence = buildReleaseImageReportEvidence({
    kind: 'sbom',
    image,
    manifest,
    manifestBytes,
    reportPath: reportName,
    reportBytes: report.bytes,
    certificateIdentity: options.certificateIdentity,
    oidcIssuer: options.oidcIssuer,
  });
  for (const [key, expected] of Object.entries(expectedEvidence)) {
    if (JSON.stringify(evidence?.[key]) !== JSON.stringify(expected)) {
      fail(`${evidenceName} ${key} does not match the release manifest, report, or signer policy.`);
    }
  }
  if (Object.keys(evidence).length !== Object.keys(expectedEvidence).length) {
    fail(`${evidenceName} contains unsupported fields.`);
  }

  const document = report.value;
  if (!document || typeof document !== 'object') fail(`${reportName} must contain an SPDX document.`);
  if (!/^SPDX-2\./.test(String(document.spdxVersion ?? ''))) {
    fail(`${reportName} spdxVersion must be SPDX-2.x.`);
  }
  if (document.SPDXID !== 'SPDXRef-DOCUMENT' || document.dataLicense !== 'CC0-1.0') {
    fail(`${reportName} must identify a CC0 SPDX document.`);
  }
  if (typeof document.documentNamespace !== 'string' || !document.documentNamespace.trim()) {
    fail(`${reportName} documentNamespace is required.`);
  }
  if (!Array.isArray(document.packages) || document.packages.length === 0) {
    fail(`${reportName} must contain at least one package.`);
  }
  const creators = document.creationInfo?.creators;
  if (!Array.isArray(creators) || !creators.some((value) => /^Tool: syft-/i.test(String(value)))) {
    fail(`${reportName} must identify Syft as a creator.`);
  }

  try {
    verifySignedReportProvenance({
      evidencePath: join(reportsDir, evidenceName),
      signatureBundlePath: join(reportsDir, signatureName),
      imageRef: image.ref,
      certificateIdentity: options.certificateIdentity,
      oidcIssuer: options.oidcIssuer,
      registryAttestationRequired: image.registryAttestationRequired,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const options = parseArgs(process.argv.slice(2));
const manifestFile = readJson(options.manifestPath, 'release manifest');
const manifest = manifestFile.value;
if (!/^[a-f0-9]{40}$/i.test(String(manifest?.sourceSha ?? ''))) {
  fail('release manifest sourceSha must be a full Git SHA.');
}

let inventory;
try {
  inventory = deriveProductionImageInventory({ manifestPath: options.manifestPath });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const images = options.service
  ? inventory.images.filter(({ name }) => name === options.service)
  : inventory.images;
if (images.length === 0) fail(`unknown production image: ${options.service}.`);
for (const image of images) verifyImage(manifest, manifestFile.bytes, options.reportsDir, image, options);

console.log(`sbom_release_reports_ok manifest_sha256=${sha256(manifestFile.bytes)} images=${images.map(({ name }) => name).join(',')}`);
