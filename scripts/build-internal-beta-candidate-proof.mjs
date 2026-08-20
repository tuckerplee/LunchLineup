import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const requiredInternalBetaGates = [
  'static-analysis',
  'terraform-validation',
  'sast',
  'codeql',
  'dependency-audit',
  'unit-tests',
  'build-images',
  'integration-tests',
  'dast',
  'e2e-tests',
  'fullstack-e2e',
  'load-test',
  'production-image-inventory',
  'sbom',
  'trivy-scan',
];

const requiredServices = [
  'api', 'api-v2', 'web', 'engine', 'worker', 'migrate', 'control', 'backup',
  'proxy', 'pgbouncer', 'postgres', 'node-exporter', 'loki', 'tempo', 'grafana',
  'alertmanager', 'otel-collector',
];
const fullShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  throw new Error(`Internal beta candidate proof rejected: ${message}`);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail(`${name} must be a nonempty trimmed string.`);
  }
  return value;
}

function parseManifest(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('release manifest must be valid JSON.');
  }
}

function verifyTrigger(sourceEvent, sourceRef) {
  if (sourceEvent === 'push') {
    if (sourceRef !== 'refs/heads/internal-beta-candidate') {
      fail('push candidates must come from refs/heads/internal-beta-candidate.');
    }
    return;
  }
  if (sourceEvent === 'workflow_dispatch') {
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef) || sourceRef.includes('..')) {
      fail('manual candidates must select a concrete branch ref.');
    }
    return;
  }
  fail('sourceEvent must be push or workflow_dispatch.');
}

function verifyGates(gateResults) {
  if (!gateResults || typeof gateResults !== 'object' || Array.isArray(gateResults)) {
    fail('gate results must be an object.');
  }
  const actualNames = Object.keys(gateResults).sort();
  const expectedNames = [...requiredInternalBetaGates].sort();
  if (actualNames.join('\n') !== expectedNames.join('\n')) {
    fail(`gate results must exactly name: ${requiredInternalBetaGates.join(', ')}.`);
  }
  for (const name of requiredInternalBetaGates) {
    if (gateResults[name] !== 'success') {
      fail(`${name} must be success; received ${String(gateResults[name])}.`);
    }
  }
}

function verifyManifest(manifest, sourceSha, workflowRun) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('release manifest must be an object.');
  }
  if (manifest.version !== 1) fail('release manifest version must be 1.');
  if (manifest.releaseTarget !== 'internal-beta') {
    fail('release manifest must declare releaseTarget=internal-beta.');
  }
  if (manifest.sourceSha !== sourceSha) fail('release manifest sourceSha does not match the candidate SHA.');
  if (manifest.workflowRun !== workflowRun) fail('release manifest workflowRun does not match this run.');
  if (manifest.productionHealthProof?.domain !== 'beta.lunchlineup.com') {
    fail('release manifest must bind beta.lunchlineup.com.');
  }
  if (manifest.productionHealthProof?.url !== 'https://beta.lunchlineup.com/health') {
    fail('release manifest must bind the canonical beta health URL.');
  }
  const publicValues = manifest.publicBuildConfig?.values;
  if (publicValues?.NEXT_PUBLIC_API_URL !== '/api/v2') {
    fail('beta web images must use the same-origin /api/v2 boundary.');
  }
  if (publicValues?.NEXT_PUBLIC_APP_ORIGIN !== 'https://beta.lunchlineup.com'
    || publicValues?.NEXT_PUBLIC_APP_URL !== 'https://beta.lunchlineup.com') {
    fail('beta web images must bind the canonical beta origin and URL.');
  }
  if (publicValues?.NEXT_PUBLIC_APP_ENV !== 'production') {
    fail('beta web images must use production browser safeguards.');
  }
  if (publicValues?.NEXT_PUBLIC_SIGNUP_MODE !== 'closed_beta') {
    fail('beta web images must keep signup in exact closed_beta mode.');
  }

  if (!manifest.images || typeof manifest.images !== 'object' || Array.isArray(manifest.images)) {
    fail('release manifest images must be an object.');
  }
  const actualServices = Object.keys(manifest.images).sort();
  if (actualServices.join('\n') !== [...requiredServices].sort().join('\n')) {
    fail(`release manifest must exactly contain: ${requiredServices.join(', ')}.`);
  }
  const images = {};
  for (const service of requiredServices) {
    const image = manifest.images[service];
    const digest = requireString(image?.digest, `images.${service}.digest`);
    const ref = requireString(image?.ref, `images.${service}.ref`);
    if (!digestPattern.test(digest)) fail(`images.${service}.digest must be an OCI SHA-256 digest.`);
    const expectedRef = `${manifest.imagePrefix}/${service}:${sourceSha}@${digest}`;
    if (ref !== expectedRef) fail(`images.${service}.ref must equal ${expectedRef}.`);
    images[service] = { digest, ref };
  }
  return images;
}

export function buildInternalBetaCandidateProof({
  gateResults,
  manifestBytes,
  repository,
  runAttempt,
  runId,
  sourceEvent,
  sourceRef,
  sourceSha,
  remoteSourceSha,
  workflowRun,
  generatedAt = new Date().toISOString(),
}) {
  sourceSha = requireString(sourceSha, 'sourceSha');
  remoteSourceSha = requireString(remoteSourceSha, 'remoteSourceSha');
  sourceRef = requireString(sourceRef, 'sourceRef');
  sourceEvent = requireString(sourceEvent, 'sourceEvent');
  repository = requireString(repository, 'repository');
  runId = requireString(runId, 'runId');
  runAttempt = requireString(runAttempt, 'runAttempt');
  workflowRun = requireString(workflowRun, 'workflowRun');
  generatedAt = requireString(generatedAt, 'generatedAt');

  if (!fullShaPattern.test(sourceSha)) fail('sourceSha must be a lowercase 40-character Git SHA.');
  if (remoteSourceSha !== sourceSha) fail('remote branch head must exactly match sourceSha.');
  verifyTrigger(sourceEvent, sourceRef);
  if (!repositoryPattern.test(repository)) fail('repository must be owner/name.');
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    fail('runId and runAttempt must be positive integers.');
  }
  const expectedWorkflowRun = `https://github.com/${repository}/actions/runs/${runId}`;
  if (workflowRun !== expectedWorkflowRun) fail(`workflowRun must equal ${expectedWorkflowRun}.`);
  if (!Number.isFinite(Date.parse(generatedAt))) fail('generatedAt must be an ISO timestamp.');
  verifyGates(gateResults);

  const manifest = parseManifest(manifestBytes);
  const images = verifyManifest(manifest, sourceSha, workflowRun);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

  return {
    version: 1,
    kind: 'lunchlineup-internal-beta-candidate-proof',
    releaseTarget: 'internal-beta',
    generatedAt,
    repository,
    source: {
      event: sourceEvent,
      ref: sourceRef,
      sha: sourceSha,
      remoteSha: remoteSourceSha,
    },
    workflow: {
      runAttempt: Number(runAttempt),
      runId: Number(runId),
      url: workflowRun,
    },
    releaseManifest: {
      sha256: manifestSha256,
      images,
    },
    gates: Object.fromEntries(requiredInternalBetaGates.map((name) => [name, 'success'])),
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) fail(`${name} is required.`);
  return process.argv[index + 1];
}

function run() {
  const manifestPath = argumentValue('--manifest');
  const outputPath = argumentValue('--output');
  if (existsSync(outputPath)) fail('output path already exists.');
  let gateResults;
  try {
    gateResults = JSON.parse(process.env.INTERNAL_BETA_GATE_RESULTS ?? '');
  } catch {
    fail('INTERNAL_BETA_GATE_RESULTS must be valid JSON.');
  }
  const proof = buildInternalBetaCandidateProof({
    gateResults,
    manifestBytes: readFileSync(manifestPath),
    repository: process.env.GITHUB_REPOSITORY,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runId: process.env.GITHUB_RUN_ID,
    sourceEvent: process.env.GITHUB_EVENT_NAME,
    sourceRef: process.env.GITHUB_REF,
    sourceSha: process.env.GITHUB_SHA,
    remoteSourceSha: process.env.INTERNAL_BETA_REMOTE_SOURCE_SHA,
    workflowRun: process.env.INTERNAL_BETA_WORKFLOW_RUN,
  });
  writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`internal_beta_candidate_proof_ok source_sha=${proof.source.sha} manifest_sha256=${proof.releaseManifest.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
