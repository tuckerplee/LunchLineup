import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const sourceSha = process.env.CI_COMMIT_SHA ?? '';
const sourceRef = process.env.CI_REF ?? '';
const runId = process.env.CI_RUN_ID ?? '';
const repository = process.env.CI_REPOSITORY ?? '';
const evidenceRoot = resolve(process.argv[2] ?? '');
if (!/^[a-f0-9]{40}$/.test(sourceSha) || sourceRef !== 'refs/heads/internal-beta-candidate' || !runId || !repository || !existsSync(evidenceRoot)) {
  throw new Error('Internal candidate receipt requires exact Custom CI source identity and evidence root.');
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const requiredGates = ['source-validation', 'dependency-license', 'sast', 'integration', 'release-images', 'fullstack-e2e', 'interaction-proof', 'dast', 'load', 'sbom', 'trivy'];
const gates = Object.fromEntries(requiredGates.map((name) => {
  const path = join(evidenceRoot, 'gates', `${name}.json`);
  const gate = readJson(path);
  if (gate.name !== name || gate.status !== 'passed' || gate.sourceSha !== sourceSha || gate.attempts !== 1) {
    throw new Error(`Gate ${name} is missing, stale, skipped, retried, or failed.`);
  }
  return [name, gate];
}));
const manifestPath = join(evidenceRoot, 'release-manifest.json');
const manifest = readJson(manifestPath);
if (manifest.sourceSha !== sourceSha || manifest.sourceRef !== sourceRef || Object.keys(manifest.images ?? {}).length !== 17) {
  throw new Error('Release manifest is not exact and complete.');
}
const interactionPath = join(evidenceRoot, 'interaction-proof.json');
const interaction = readJson(interactionPath);
if (interaction.sourceSha !== sourceSha) throw new Error('Interaction proof source SHA mismatch.');
const inventory = [];
function collect(path) {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) collect(child);
    else inventory.push({ path: child.slice(evidenceRoot.length + 1).replaceAll('\\', '/'), sha256: sha256(child) });
  }
}
collect(evidenceRoot);
const pipelinePath = resolve('.ci/pipeline.json');
const receipt = {
  version: 1,
  kind: 'lunchlineup-internal-beta-candidate-receipt',
  status: 'passed',
  repository,
  source: { sha: sourceSha, ref: sourceRef, event: process.env.CI_EVENT },
  ci: { runId, pipelineSha256: sha256(pipelinePath) },
  startedAt: gates['source-validation'].startedAt,
  completedAt: new Date().toISOString(),
  gates: Object.fromEntries(requiredGates.map((name) => [name, 'passed'])),
  testInventory: { interactionCases: Object.values(interaction.cases ?? {}).flatMap(Object.keys).length },
  interactionProof: { sha256: sha256(interactionPath), path: basename(interactionPath) },
  releaseManifest: { sha256: sha256(manifestPath), images: manifest.images },
  securityReports: inventory.filter(({ path }) => /^(semgrep|sbom|trivy|dast|load)\//.test(path)),
  evidenceInventory: inventory,
};
const output = join(evidenceRoot, `internal-beta-candidate-receipt-${sourceSha}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(`internal_beta_candidate_receipt_ok source_sha=${sourceSha} receipt_sha256=${sha256(output)}`);
