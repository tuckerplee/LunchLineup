import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REQUIRED_INTERNAL_BETA_GATES } from './internal-ci-policy.mjs';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { assertNoAbsoluteHostPaths, sha256File, statRegularEvidenceFile, writeExclusiveJson } from './internal-ci-evidence.mjs';

const args = process.argv.slice(2);
const all = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ''] : []);
const one = (flag) => all(flag)[0] ?? '';
const name = one('--name'), contextPath = resolve(one('--source-context')), output = resolve(one('--output')), startedAt = one('--started-at'), resultPath = resolve(one('--command-result')), detailsPath = resolve(one('--details'));
if (!REQUIRED_INTERNAL_BETA_GATES.includes(name) || !one('--source-context') || !one('--output') || !startedAt || !one('--command-result') || !one('--details')) throw new Error('Invalid internal CI gate arguments.');
const context = readInternalCiSourceContext(contextPath);
const attempt = Number(process.env.CI_RUN_ATTEMPT ?? '');
if (!process.env.CI_RUN_ATTEMPT || attempt !== 1) throw new Error('CI_RUN_ATTEMPT must be controller-supplied and equal to one.');
const started = Date.parse(startedAt);
if (!Number.isFinite(started) || started >= Date.now()) throw new Error('Gate start time is invalid.');
const resultItem = statRegularEvidenceFile(resultPath, context.evidenceRoot);
const commandResult = JSON.parse(readFileSync(resultPath, 'utf8'));
if (commandResult.version !== 1 || commandResult.kind !== 'lunchlineup-internal-ci-command-result' || commandResult.name !== name || commandResult.status !== 'passed' || commandResult.repository !== context.repository || commandResult.runId !== context.runId || commandResult.sourceSha !== context.sourceSha || commandResult.treeSha !== context.treeSha || commandResult.attempt !== attempt || commandResult.exitCode !== 0 || commandResult.startedAt !== startedAt || !Number.isFinite(Date.parse(commandResult.completedAt ?? '')) || Date.parse(commandResult.completedAt) <= started || Date.parse(commandResult.completedAt) > Date.now() + 30000) throw new Error('Failed, missing, or mismatched command result.');
const completedAt = commandResult.completedAt;
const evidence = [];
for (const evidenceArg of all('--evidence')) {
  const path = resolve(evidenceArg), item = statRegularEvidenceFile(path, context.evidenceRoot);
  if (evidence.some((entry) => entry.path === item.path)) throw new Error('Duplicate gate evidence path.');
  evidence.push({ ...item, sha256: await sha256File(path, context.evidenceRoot) });
}
if (evidence.length === 0) throw new Error('Gate evidence is required.');
const detailsItem = statRegularEvidenceFile(detailsPath, context.evidenceRoot);
const details = JSON.parse(readFileSync(detailsPath, 'utf8'));
assertNoAbsoluteHostPaths(details, 'Gate details');
if (details.sourceSha && details.sourceSha !== context.sourceSha) throw new Error('Gate details are bound to another source SHA.');
const sourceProof = statRegularEvidenceFile(context.sourceProofPath, context.artifactRoot);
const sourceProofSha256 = await sha256File(context.sourceProofPath, context.artifactRoot);
writeExclusiveJson(output, { version: 2, kind: 'lunchlineup-internal-ci-gate', name, status: 'passed', repository: context.repository, runId: context.runId, sourceRef: context.sourceRef, sourceSha: context.sourceSha, treeSha: context.treeSha, baselineSha: context.baselineSha, pipelineSha256: context.pipelineSha256, sourceProofSha256, sourceProof: sourceProof.path, attempt, startedAt, completedAt, commandResult: { ...resultItem, sha256: await sha256File(resultPath, context.evidenceRoot) }, evidence, details: { ...details, evidenceFile: detailsItem.path } }, { root: context.evidenceRoot });
