import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { readRegularEvidenceSnapshot, writeExclusiveJson } from './internal-ci-evidence.mjs';

const args = process.argv.slice(2);
const one = (flag) => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1] ?? ''; };
const context = readInternalCiSourceContext(resolve(one('--source-context')));
const language = one('--language');
const sarifPath = resolve(one('--sarif'));
const baselinePath = resolve(one('--baseline'));
const detailsPath = resolve(one('--details'));
const bundleSha256 = one('--bundle-sha256');
const allowedLanguages = new Set(['javascript-typescript', 'python']);
const querySuites = {
  'javascript-typescript': 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls',
  python: 'codeql/python-queries:codeql-suites/python-security-extended.qls',
};
if (!allowedLanguages.has(language) || !/^[a-f0-9]{64}$/.test(bundleSha256)) throw new Error('Invalid CodeQL identity.');

const sarifSnapshot = readRegularEvidenceSnapshot(sarifPath, context.evidenceRoot);
const sarif = JSON.parse(sarifSnapshot.bytes.toString('utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (!Array.isArray(sarif.runs) || !sarif.runs.length || sarif.runs.some((run) => run?.invocations?.some((invocation) => invocation.executionSuccessful === false))) throw new Error('Invalid CodeQL evidence.');
if (baseline.version !== 2 || baseline.kind !== 'lunchlineup-codeql-baseline' || baseline.fingerprintSchema !== 'primary-location-v1' || baseline.codeqlBundleSha256 !== bundleSha256 || baseline.querySuites?.['javascript-typescript'] !== querySuites['javascript-typescript'] || baseline.querySuites?.python !== querySuites.python || !Array.isArray(baseline.findings)) throw new Error('Invalid CodeQL baseline.');

const findingKey = (finding) => [finding.language, finding.ruleId, finding.primaryLocationLineHash, finding.primaryLocationStartColumnFingerprint].join('\0');
const expectedKeys = new Set();
for (const item of baseline.findings) {
  const triagedAt = Date.parse(item.triagedAt ?? '');
  const expiresAt = Date.parse(item.expiresAt ?? '');
  if (!allowedLanguages.has(item.language) || typeof item.ruleId !== 'string' || !item.ruleId || item.ruleId.length > 256 || typeof item.primaryLocationLineHash !== 'string' || !item.primaryLocationLineHash || item.primaryLocationLineHash.length > 512 || typeof item.primaryLocationStartColumnFingerprint !== 'string' || !item.primaryLocationStartColumnFingerprint || item.primaryLocationStartColumnFingerprint.length > 512 || typeof item.owner !== 'string' || !item.owner || item.owner.length > 128 || typeof item.reason !== 'string' || !item.reason || item.reason.length > 1024 || !Number.isFinite(triagedAt) || triagedAt > Date.now() || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - triagedAt > 180 * 24 * 60 * 60 * 1000) throw new Error('Invalid CodeQL baseline.');
  const key = findingKey(item);
  if (expectedKeys.has(key)) throw new Error('Duplicate CodeQL baseline item.');
  expectedKeys.add(key);
}

const findings = [];
const findingKeys = new Set();
for (const result of sarif.runs.flatMap((run) => run.results ?? [])) {
  const lineHash = result?.partialFingerprints?.primaryLocationLineHash;
  const startColumn = result?.partialFingerprints?.primaryLocationStartColumnFingerprint;
  const fingerprintKeys = Object.keys(result?.partialFingerprints ?? {}).sort();
  if (fingerprintKeys.join(',') !== 'primaryLocationLineHash,primaryLocationStartColumnFingerprint' || typeof result?.ruleId !== 'string' || !result.ruleId || result.ruleId.length > 256 || typeof lineHash !== 'string' || !lineHash || lineHash.length > 512 || typeof startColumn !== 'string' || !startColumn || startColumn.length > 512) throw new Error('CodeQL result lacks the required stable primary-location fingerprint.');
  const finding = { language, ruleId: result.ruleId, primaryLocationLineHash: lineHash, primaryLocationStartColumnFingerprint: startColumn };
  const key = findingKey(finding);
  if (findingKeys.has(key)) throw new Error('Duplicate CodeQL result fingerprint.');
  findingKeys.add(key);
  findings.push(finding);
}

const approvedForLanguage = new Set(baseline.findings.filter((item) => item.language === language).map(findingKey));
const unapproved = findings.filter((finding) => !approvedForLanguage.has(findingKey(finding)));
const stale = baseline.findings.filter((item) => item.language === language && !findingKeys.has(findingKey(item)));
if (unapproved.length) throw new Error(`Unapproved CodeQL findings: ${unapproved.length}; first=${unapproved[0].ruleId}.`);
if (stale.length) throw new Error(`Stale CodeQL baseline items: ${stale.length}; first=${stale[0].ruleId}.`);

writeExclusiveJson(detailsPath, {
  sourceSha: context.sourceSha,
  treeSha: context.treeSha,
  language,
  bundleSha256,
  fingerprintSchema: baseline.fingerprintSchema,
  querySuite: querySuites[language],
  findings: findings.length,
  unapprovedFindings: 0,
  report: { path: sarifSnapshot.path, sha256: createHash('sha256').update(sarifSnapshot.bytes).digest('hex'), bytes: sarifSnapshot.bytes.length },
}, { root: context.evidenceRoot });
