// Private proposal: evidence validation grants no signing or launch admission.
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { readRegularEvidenceSnapshot, sha256File, statRegularEvidenceFile, writeExclusiveJson } from './internal-ci-evidence.mjs';
import { verifyDevelopmentBrowserReport } from './verify-development-browser-report.mjs';
import { verifyInteractionProofReport } from '../apps/web/tests/e2e/verify-internal-beta-interaction-proof.mjs';

const [buildRoot, root, sourceSha, runId, output] = process.argv.slice(2);
if (process.argv.length !== 7 || !/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-zA-Z0-9-]+$/.test(runId)) {
  throw new Error('Browser cohort identity is missing.');
}
const snapshots = new Map();
function snapshot(path, boundary = root) {
  const absolute = resolve(path);
  if (!snapshots.has(absolute)) {
    const bytes = readRegularEvidenceSnapshot(absolute, boundary).bytes;
    snapshots.set(absolute, { bytes, boundary, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return snapshots.get(absolute);
}
const read = (path, boundary) => JSON.parse(snapshot(path, boundary).bytes.toString('utf8'));
const digest = (path, boundary) => snapshot(path, boundary).sha256;
const releasePath = resolve(root, 'release-manifest.json'), release = read(releasePath);
if (release.sourceSha !== sourceSha || release.runId !== runId || !/^[a-f0-9]{40}$/.test(release.treeSha)) {
  throw new Error('Wrong release source/tree/run.');
}
const webImageId = release.images?.[release.services?.web?.imageArtifact]?.localImageId;
const publicBuildConfigSha256 = release.publicBuildConfig?.sha256;
if (!/^sha256:[a-f0-9]{64}$/.test(webImageId) || !/^[a-f0-9]{64}$/.test(publicBuildConfigSha256)) {
  throw new Error('Malformed release image/public-config identity.');
}
const specs = [
  ['canonical-baseline', 'development-browser-cases.json', 'fullstack', 30],
  ['interaction-proof-artifacts', 'development-browser-cases.json', 'interaction', 5],
  ['canonical-logout', 'development-logout-cases.json', 'fullstack', 4],
  ['canonical-staff', 'development-staff-cases.json', 'fullstack', 8],
];
let previousEnd = -Infinity;
const mediaEvidence = [];
const mediaTypes = new Set(['image/png', 'video/webm', 'application/zip']);
const mediaPaths = new Set();
const mediaSnapshots = [];
const cohorts = [];
for (const [scope, manifestFile, lane, count] of specs) {
  const path = file => resolve(root, scope, file), manifestPath = resolve(buildRoot, '.ci', manifestFile);
  const report = read(path('results.json'));
  const actual = verifyDevelopmentBrowserReport(read(manifestPath, buildRoot), lane, read(path('selection.json')), report);
  const retained = read(path('acceptance-proof.json'));
  const expectedSupporting = { ...actual, candidateSha: sourceSha, runId,
    manifestSha256: digest(manifestPath, buildRoot), selectionSha256: digest(path('selection.json')),
    reportSha256: digest(path('results.json')) };
  if (actual.executed !== count || retained.runId !== runId ||
      JSON.stringify(stable(retained)) !== JSON.stringify(stable(expectedSupporting))) {
    throw new Error('Wrong/incomplete cohort or supporting proof identity.');
  }
  const start = Date.parse(report.stats.startTime), end = start + report.stats.duration;
  if (start < previousEnd) throw new Error('Browser fixture lifetimes overlap or run out of reviewed order.');
  previousEnd = end;
  async function inspectMedia(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        const test = spec.tests[0], attachments = test.results[0].attachments;
        if (!Array.isArray(attachments)) throw new Error('Missing actual media attachment inventory.');
        const required = lane === 'interaction'
          ? [['screenshot', 'image/png'], ['video', 'video/webm'], ['trace', 'application/zip']]
          : [['trace', 'application/zip']];
        for (const [name, type] of required) {
          if (!attachments.some(item => item.name === name && item.contentType === type && typeof item.path === 'string')) {
            throw new Error('Missing actual retained canonical browser media.');
          }
        }
        if (['access-home-acceptance.spec.ts', 'location-lifecycle-acceptance.spec.ts',
             'logout-surfaces-acceptance.spec.ts', 'staff-lifecycle-acceptance.spec.ts'].includes(spec.file) &&
            !attachments.some(item => item.contentType === 'image/png' && typeof item.path === 'string')) {
          throw new Error('Missing decisive native screenshot.');
        }
        for (const item of attachments) {
          if (!mediaTypes.has(item.contentType)) continue;
          if (typeof item.name !== 'string' || typeof item.path !== 'string' || /[\r\n\0]/.test(item.path)) {
            throw new Error('Browser media must be a retained regular file.');
          }
          const absolute = resolve(item.path), boundary = path('');
          const captured = statRegularEvidenceFile(absolute, boundary);
          const sha256 = await sha256File(absolute, boundary);
          const evidencePath = relative(resolve(root), absolute).replaceAll('\\', '/');
          if (captured.bytes === 0 || mediaPaths.has(evidencePath)) {
            throw new Error('Empty/reused canonical browser media.');
          }
          mediaPaths.add(evidencePath);
          mediaSnapshots.push({absolute, boundary, bytes: captured.bytes, sha256});
          mediaEvidence.push({scope, file: spec.file, title: spec.title, project: test.projectName,
            name: item.name, contentType: item.contentType, path: evidencePath,
            bytes: captured.bytes, sha256});
        }
      }
      if (suite.suites) await inspectMedia(suite.suites);
    }
  }
  await inspectMedia(report.suites);
  cohorts.push({ scope, lane, executed: count, supportingProofReleaseQualified: false,
    manifestSha256: digest(manifestPath, buildRoot), selectionSha256: digest(path('selection.json')),
    reportSha256: digest(path('results.json')), acceptanceProofSha256: digest(path('acceptance-proof.json')),
    startedAt: report.stats.startTime, completedAt: new Date(end).toISOString() });
}
const interactionPath = resolve(root, 'interaction-proof.json'), interaction = read(interactionPath);
const bindings = { candidateTreeSha: release.treeSha, releaseManifestSha256: digest(releasePath), webImageId, publicBuildConfigSha256 };
const expectedInteraction = verifyInteractionProofReport(read(resolve(root, 'interaction-proof-artifacts/results.json')), sourceSha, bindings);
expectedInteraction.playwrightReportSha256 = digest(resolve(root, 'interaction-proof-artifacts/results.json'));
// Compare fields, including every exact case and artifact policy, without depending on JSON key order.
function stable(value) {
  return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
if (JSON.stringify(stable(interaction)) !== JSON.stringify(stable(expectedInteraction))) {
  throw new Error('Canonical interaction/release binding mismatch.');
}
// Parsing and all digests use one immutable read per file. Reject changes before emitting a receipt.
for (const [path, retained] of snapshots) {
  const current = readRegularEvidenceSnapshot(path, retained.boundary).bytes;
  if (!current.equals(retained.bytes)) throw new Error('Browser evidence changed during validation.');
}
// Media hashes stream through the existing evidence owner; retain no full videos/traces in memory.
for (const retained of mediaSnapshots) {
  if (statRegularEvidenceFile(retained.absolute, retained.boundary).bytes !== retained.bytes ||
      await sha256File(retained.absolute, retained.boundary) !== retained.sha256) {
    throw new Error('Browser media changed during validation.');
  }
}
writeExclusiveJson(output, {sourceSha, runId, treeSha: release.treeSha, fullStack: true, mockApi: false,
  passed: 42, failed: 0, skipped: 0, flaky: 0, interactionCases: 5, workers: 1, retries: 0,
  releaseManifestSha256: digest(releasePath), webImageId, publicBuildConfigSha256,
  interactionProofSha256: digest(interactionPath), cohorts, mediaEvidence}, {root});
