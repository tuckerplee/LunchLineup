#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveProductionImageInventory } from './production-image-inventory.mjs';
import { signedReportPolicy } from './signed-report-provenance.mjs';

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildReleaseImageReportEvidence({
  kind,
  image,
  manifest,
  manifestBytes,
  reportPath,
  reportBytes,
  certificateIdentity,
  oidcIssuer,
}) {
  const common = {
    version: 3,
    scanner: kind === 'sbom' ? 'syft' : 'trivy',
    sourceSha: manifest.sourceSha,
    service: image.name,
    composeServices: image.composeServices,
    imageSource: image.source,
    imageRef: image.ref,
    imageDigest: image.digest,
    releaseManifestSha256: sha256(manifestBytes),
    reportFile: basename(reportPath),
    reportSha256: sha256(reportBytes),
  };
  if (kind === 'sbom') common.format = 'spdx-json';
  else if (kind === 'trivy') common.severityGate = ['HIGH', 'CRITICAL'];
  else fail('report kind must be sbom or trivy.');
  common.provenance = signedReportPolicy(certificateIdentity, oidcIssuer, image.registryAttestationRequired);
  return common;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) fail(`${name} is required.`);
  return argv[index + 1];
}

function optional(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
}

function main(argv) {
  const manifestPath = resolve(option(argv, '--manifest'));
  const reportPath = resolve(option(argv, '--report'));
  const outputPath = resolve(option(argv, '--output'));
  const service = option(argv, '--service');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const composePath = optional(argv, '--compose');
  const inventory = deriveProductionImageInventory({ manifestPath, ...(composePath ? { composePath } : {}) });
  const image = inventory.images.find(({ name }) => name === service);
  if (!image) fail(`unknown production image: ${service}.`);
  const evidence = buildReleaseImageReportEvidence({
    kind: option(argv, '--kind'),
    image,
    manifest,
    manifestBytes,
    reportPath,
    reportBytes: readFileSync(reportPath),
    certificateIdentity: option(argv, '--certificate-identity'),
    oidcIssuer: option(argv, '--oidc-issuer'),
  });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Release image report evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
