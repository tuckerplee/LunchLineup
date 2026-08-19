import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  requiredInteractionProofCases,
  verifyInteractionProofReport,
} from '../../apps/web/tests/e2e/verify-internal-beta-interaction-proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const sourceSha = 'a'.repeat(40);

function report(overrides = {}) {
  return {
    config: { metadata: { candidateSha: sourceSha } },
    suites: [...requiredInteractionProofCases].map(([projectName, titles]) => ({
      specs: titles.map((title) => ({
        title,
        tests: [{ projectName, expectedStatus: 'passed', annotations: [], results: [{ status: 'passed' }] }],
      })),
    })),
    ...overrides,
  };
}

test('interaction proof verifier requires every unskipped desktop and touch case exactly once', () => {
  const proof = verifyInteractionProofReport(report(), sourceSha);
  assert.equal(proof.sourceSha, sourceSha);
  assert.equal(Object.keys(proof.cases['interaction-desktop']).length, 4);
  assert.equal(Object.keys(proof.cases['interaction-touch']).length, 1);
  assert.deepEqual(proof.artifactPolicy, { trace: 'on', video: 'on', screenshot: 'on' });

  const skipped = report();
  skipped.suites[0].specs[0].tests[0].expectedStatus = 'skipped';
  assert.throws(() => verifyInteractionProofReport(skipped, sourceSha), /declared skipped/);
  const fixme = report();
  fixme.suites[0].specs[0].tests[0].annotations.push({ type: 'fixme' });
  assert.throws(() => verifyInteractionProofReport(fixme, sourceSha), /declared skipped or fixme/);
  const retried = report();
  retried.suites[0].specs[0].tests[0].results.push({ status: 'passed' });
  assert.throws(() => verifyInteractionProofReport(retried, sourceSha), /exactly one passed attempt/);
  const missing = report();
  missing.suites[0].specs.pop();
  assert.throws(() => verifyInteractionProofReport(missing, sourceSha), /case inventory/);
  const wrongSha = report();
  wrongSha.config.metadata.candidateSha = 'b'.repeat(40);
  assert.throws(() => verifyInteractionProofReport(wrongSha, sourceSha), /candidate SHA/);
});

test('release-image full-stack lane runs and retains exact-SHA interaction evidence', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml'));
  const fullstack = workflow.jobs['fullstack-e2e'];
  const run = fullstack.steps.find((step) => step.name === 'Run launch-blocking internal-beta interaction proof');
  const verify = fullstack.steps.find((step) => step.name === 'Reject missing or skipped interaction proof cases');
  const upload = fullstack.steps.find((step) => step.with?.name === 'internal-beta-interaction-proof-${{ github.sha }}');
  assert.ok(run);
  assert.equal(run.env.E2E_CANDIDATE_SHA, '${{ github.sha }}');
  assert.match(run.run, /playwright\.interaction-proof\.config\.ts/);
  assert.match(verify.run, /verify-internal-beta-interaction-proof\.mjs/);
  assert.match(verify.run, /--source-sha "\$GITHUB_SHA"/);
  assert.equal(upload.if, '${{ always() }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 90);
  assert.match(upload.with.path, /internal-beta-interaction-proof-\$\{\{ github\.sha \}\}/);
});

test('critical interaction source contains no skip and names every launch contract', () => {
  const desktop = read('apps/web/tests/e2e/internal-beta-interaction-desktop.proof.ts');
  const touch = read('apps/web/tests/e2e/internal-beta-interaction-touch.proof.ts');
  const config = read('apps/web/playwright.interaction-proof.config.ts');
  assert.doesNotMatch(`${desktop}\n${touch}`, /test\.(?:skip|fixme)|\.skip\(/);
  for (const phrase of [
    'slight movement', 'outside drop', 'Escape', 'pointercancel', 'exact proposed employee and time',
    'Saved and Undo', 'failed move restores only that shift', 'keyboard editing', 'overnight values',
    'only supported explicit actions', 'whole-board read', 'separately purchased usage credit',
    'Select a team member and location', 'real touch scroll', 'dedicated handle',
  ]) assert.match(`${desktop}\n${touch}`, new RegExp(phrase));
  assert.match(config, /trace: 'on'/);
  assert.match(config, /screenshot: 'on'/);
  assert.match(config, /video: 'on'/);
  assert.match(config, /retries: 0/);
  assert.match(config, /candidateSha/);
});
