#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const requiredServices = ['api', 'web', 'engine', 'worker', 'migrate', 'control', 'backup'];

function fail(message) {
  console.error(`Trivy release report verification failed: ${message}`);
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
    console.log('Usage: node scripts/verify-trivy-release-reports.mjs <release-manifest.json> <reports-dir> [--service NAME]');
    process.exit(0);
  }
  const manifestPath = argv[0];
  const reportsDir = argv[1];
  let service = null;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--service') {
      service = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${argv[index]}`);
  }
  if (!manifestPath || !reportsDir) fail('release manifest and reports directory are required.');
  if (service && !requiredServices.includes(service)) fail(`unknown release service: ${service}.`);
  return { manifestPath: resolve(manifestPath), reportsDir: resolve(reportsDir), service };
}

function verifyService(manifest, manifestSha256, reportsDir, service) {
  const image = manifest.images?.[service];
  if (!image || typeof image !== 'object') fail(`manifest images.${service} is required.`);

  const reportName = `${service}.trivy.json`;
  const evidenceName = `${service}.trivy-evidence.json`;
  const report = readJson(join(reportsDir, reportName), `${service} Trivy report`);
  const evidence = readJson(join(reportsDir, evidenceName), `${service} Trivy evidence`).value;

  const expectedEvidence = {
    version: 1,
    scanner: 'trivy',
    sourceSha: manifest.sourceSha,
    service,
    imageRef: image.ref,
    imageDigest: image.digest,
    releaseManifestSha256: manifestSha256,
    reportFile: reportName,
    reportSha256: sha256(report.bytes),
  };
  for (const [key, expected] of Object.entries(expectedEvidence)) {
    if (evidence?.[key] !== expected) {
      fail(`${evidenceName} ${key} does not match the release manifest or report.`);
    }
  }
  if (JSON.stringify(evidence.severityGate) !== JSON.stringify(['HIGH', 'CRITICAL'])) {
    fail(`${evidenceName} severityGate must be exactly HIGH,CRITICAL.`);
  }

  if (!report.value || typeof report.value !== 'object' || !Array.isArray(report.value.Results)) {
    fail(`${reportName} must be a Trivy JSON report with a Results array.`);
  }
  if (report.value.ArtifactName !== image.ref) {
    fail(`${reportName} ArtifactName does not match images.${service}.ref.`);
  }

  const blocked = [];
  for (const result of report.value.Results) {
    const vulnerabilities = result?.Vulnerabilities;
    if (vulnerabilities == null) continue;
    if (!Array.isArray(vulnerabilities)) fail(`${reportName} contains a malformed Vulnerabilities value.`);
    for (const vulnerability of vulnerabilities) {
      const severity = String(vulnerability?.Severity ?? '').toUpperCase();
      if (severity === 'HIGH' || severity === 'CRITICAL') {
        blocked.push(`${vulnerability.VulnerabilityID ?? 'unknown'}:${severity}`);
      }
    }
  }
  if (blocked.length > 0) {
    fail(`${service} image contains blocked vulnerabilities: ${blocked.slice(0, 20).join(', ')}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const manifestFile = readJson(options.manifestPath, 'release manifest');
const manifest = manifestFile.value;
if (!/^[a-f0-9]{40}$/i.test(String(manifest?.sourceSha ?? ''))) {
  fail('release manifest sourceSha must be a full Git SHA.');
}

const services = options.service ? [options.service] : requiredServices;
const manifestSha256 = sha256(manifestFile.bytes);
for (const service of services) {
  verifyService(manifest, manifestSha256, options.reportsDir, service);
}

console.log(`trivy_release_reports_ok manifest_sha256=${manifestSha256} services=${services.join(',')}`);
