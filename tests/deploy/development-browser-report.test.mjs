import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyDevelopmentBrowserReport, verifyDevelopmentSelection } from '../../scripts/verify-development-browser-report.mjs';

function fixture() {
  const config = { workers: 1, forbidOnly: true, shard: null, webServer: null,
    projects: [{ id: 'chromium', name: 'chromium', retries: 0, repeatEach: 1 }] };
  const selection = { config, errors: [], stats: { expected: 0, skipped: 2, unexpected: 0, flaky: 0 }, suites: [{ title: 'access.spec.ts', specs: [], suites: [{ title: 'Native access',
    specs: ['login', 'logout'].map(title => ({ id: title, title, file: 'access.spec.ts', ok: true, tags: ['full-stack'],
      tests: [{ projectName: 'chromium', projectId: 'chromium', expectedStatus: 'passed', annotations: [], results: [], status: 'skipped' }] })) }] }] };
  const manifest = { version: 1, releaseQualified: false, lanes: { fullstack: ['login', 'logout'].map(title => ({
    file: 'access.spec.ts', titlePath: ['access.spec.ts', 'Native access', title], project: 'chromium',
  })) } };
  const report = structuredClone(selection);
  report.config.metadata = { actualWorkers: 1 };
  report.stats = { startTime: '2026-09-30T19:00:00.000Z', duration: 5000,
    expected: 2, unexpected: 0, skipped: 0, flaky: 0 };
  for (const [index, spec] of report.suites[0].suites[0].specs.entries()) {
    spec.tests[0].status = 'expected';
    spec.tests[0].results = [{ status: 'passed', retry: 0, workerIndex: 0, parallelIndex: 0, errors: [], annotations: [],
      startTime: `2026-09-30T19:00:0${index}.000Z`, duration: 500 }];
  }
  return { manifest, selection, report };
}
const specs = value => value.suites[0].suites[0].specs;
const attempt = value => specs(value)[0].tests[0].results[0];
const verify = value => verifyDevelopmentBrowserReport(value.manifest, 'fullstack', value.selection, value.report);

function interactionFixture() {
  const value = fixture();
  // Sanitized QA26 result timings: four desktop cases followed by one touch case.
  const timings = [
    ['2026-09-30T19:40:37.569Z', 27448],
    ['2026-09-30T19:41:05.613Z', 28320],
    ['2026-09-30T19:41:34.287Z', 29494],
    ['2026-09-30T19:42:04.201Z', 33448],
    ['2026-09-30T19:42:39.369Z', 23031],
  ];
  const projects = ['interaction-desktop', 'interaction-touch'].map(name => ({ id: name, name, retries: 0, repeatEach: 1 }));
  value.selection.config.projects = structuredClone(projects);
  value.report.config.projects = structuredClone(projects);
  const template = specs(value.selection)[0];
  value.selection.suites[0].suites[0].specs = timings.map((_, index) => {
    const spec = structuredClone(template), project = projects[index === 4 ? 1 : 0].name;
    spec.title = spec.id = `gesture-${index}`;
    spec.tests[0].projectId = spec.tests[0].projectName = project;
    return spec;
  });
  value.selection.stats.skipped = 5;
  value.report.suites = structuredClone(value.selection.suites);
  value.report.stats = { startTime: '2026-09-30T19:40:36.410Z', duration: 146522.679,
    expected: 5, unexpected: 0, skipped: 0, flaky: 0 };
  for (const [index, spec] of specs(value.report).entries()) {
    spec.tests[0].status = 'expected';
    spec.tests[0].results = [{ ...structuredClone(attempt(fixture().report)), workerIndex: index === 4 ? 1 : 0,
      startTime: timings[index][0], duration: timings[index][1] }];
  }
  value.manifest.lanes = { interaction: specs(value.selection).map(spec => ({ file: spec.file,
    titlePath: ['access.spec.ts', 'Native access', spec.title], project: spec.tests[0].projectName })) };
  return value;
}
const resultAt = (value, index) => specs(value.report)[index].tests[0].results[0];
const verifyInteraction = value => verifyDevelopmentBrowserReport(value.manifest, 'interaction', value.selection, value.report);

test('actual sequential desktop and touch lifecycles occupy one slot without replacing any project worker', () => {
  const value = interactionFixture();
  const proof = verifyInteraction(value);
  assert.equal(proof.executed, 5); assert.equal(proof.workers, 1); assert.equal(proof.retries, 0);
  assert.equal(proof.releaseQualified, false);
  assert.deepEqual(proof.cases.map(row => row.project), [
    'interaction-desktop', 'interaction-desktop', 'interaction-desktop', 'interaction-desktop', 'interaction-touch',
  ]);
});

test('suite presentation order does not change the validated chronological lifecycle', () => {
  const value = interactionFixture(); specs(value.report).reverse();
  assert.equal(verifyInteraction(value).executed, 5);
});

test('adjacent intervals and a real zero-duration result are allowed within the report', () => {
  const value = fixture();
  attempt(value.report).duration = 0;
  resultAt(value, 1).startTime = attempt(value.report).startTime;
  value.report.stats.duration = resultAt(value, 1).duration;
  assert.equal(verify(value).executed, 2);
});

for (const [name, mutate] of [
  ['overlapping desktop cases', value => { resultAt(value, 1).startTime = resultAt(value, 0).startTime; }],
  ['concurrent desktop and touch despite one-slot metadata', value => { resultAt(value, 4).startTime = resultAt(value, 3).startTime; }],
  ['same-project worker restart', value => { resultAt(value, 1).workerIndex = 1; }],
  ['unaccounted initial worker', value => { for (let i = 0; i < 5; i++) resultAt(value, i).workerIndex++; }],
  ['unaccounted worker index gap', value => { resultAt(value, 4).workerIndex = 2; }],
  ['worker reused across projects', value => { resultAt(value, 4).workerIndex = 0; }],
  ['returned retired project worker', value => {
    resultAt(value, 3).startTime = '2026-09-30T19:43:03.000Z'; value.report.stats.duration = 200000;
  }],
  ['reversed worker creation order', value => { for (let i = 0; i < 5; i++) resultAt(value, i).workerIndex = i === 4 ? 0 : 1; }],
  ['out-of-report start', value => { resultAt(value, 0).startTime = '2026-09-30T19:40:36.409Z'; }],
  ['out-of-report finish', value => { value.report.stats.duration = 100000; }],
]) test(`sequential project proof rejects ${name}`, () => {
  const value = interactionFixture(); mutate(value);
  assert.throws(() => verifyInteraction(value), /Incomplete disposable browser proof/);
});

test('native lane retains its one-project worker assurance', () => {
  const value = interactionFixture();
  value.manifest.lanes.fullstack = value.manifest.lanes.interaction;
  assert.throws(() => verify(value), /native execution project multiplicity/);
});

test('listed skipped status is only a plan; exact first-attempt native execution independently passes', () => {
  const value = fixture();
  assert.equal(verifyDevelopmentSelection(value.manifest, 'fullstack', value.selection).length, 2);
  assert.deepEqual(verify(value), { kind: 'exact-disposable-development-browser-report', releaseQualified: false,
    lane: 'fullstack', passed: true, selected: 2, executed: 2, workers: 1, retries: 0,
    cases: value.manifest.lanes.fullstack.map((entry, index) => ({ ...entry, id: ['login', 'logout'][index] })) });
});

for (const [name, mutate] of [
  ['empty manifest', value => { value.manifest.lanes.fullstack = []; }],
  ['duplicate reviewed case', value => { value.manifest.lanes.fullstack.push(value.manifest.lanes.fullstack[0]); }],
  ['release claim', value => { value.manifest.releaseQualified = true; }],
  ['missing selected case', value => { specs(value.selection).pop(); }],
  ['renamed selected title', value => { specs(value.selection)[0].title = 'different login'; }],
  ['selected case in different suite', value => { value.selection.suites[0].suites[0].title = 'Other access'; }],
  ['duplicate selected ID', value => { specs(value.selection)[1].id = 'login'; }],
  ['selected skip annotation', value => { specs(value.selection)[0].tests[0].annotations.push({ type: 'skip' }); }],
  ['selected expected failure', value => { specs(value.selection)[0].tests[0].expectedStatus = 'failed'; }],
  ['execution injected into list', value => { specs(value.selection)[0].tests[0].results.push({ status: 'passed' }); }],
  ['selection report error', value => { value.selection.errors.push({ message: 'failed discovery' }); }],
  ['missing selection status', value => { delete specs(value.selection)[0].tests[0].status; }],
  ['flaky selection status', value => { specs(value.selection)[0].tests[0].status = 'flaky'; }],
  ['inconsistent selection summary', value => { value.selection.stats.skipped = 1; }],
  ['selection already executed count', value => { value.selection.stats.expected = 1; }],
  ['missing native tag', value => { specs(value.selection)[0].tags = []; }],
  ['missing execution with passing stats', value => { specs(value.report).pop(); }],
  ['extra execution with passing stats', value => { specs(value.report).push({ ...structuredClone(specs(value.report)[0]), id: 'extra', title: 'extra' }); }],
  ['duplicate execution', value => { specs(value.report).push(structuredClone(specs(value.report)[0])); }],
  ['changed execution ID', value => { specs(value.report)[0].id = 'replacement'; }],
  ['wrong execution project', value => { specs(value.report)[0].tests[0].projectName = 'firefox'; }],
  ['configured project identity mismatch', value => { value.report.config.projects[0].id = 'replacement'; }],
  ['multiple project executions', value => { specs(value.report)[0].tests.push(structuredClone(specs(value.report)[0].tests[0])); }],
  ['enabled retry policy', value => { value.report.config.projects[0].retries = 1; }],
  ['enabled repeat policy', value => { value.report.config.projects[0].repeatEach = 2; }],
  ['actual retry', value => { attempt(value.report).retry = 1; }],
  ['multiple attempts', value => { specs(value.report)[0].tests[0].results.push(structuredClone(attempt(value.report))); }],
  ['failed attempt with passing stats', value => { attempt(value.report).status = 'failed'; }],
  ['skipped attempt with passing stats', value => { attempt(value.report).status = 'skipped'; }],
  ['expected failure on executed case', value => { specs(value.report)[0].tests[0].expectedStatus = 'failed'; }],
  ['fixme on executed case', value => { specs(value.report)[0].tests[0].annotations.push({ type: 'fixme' }); }],
  ['failure annotation on attempt', value => { attempt(value.report).annotations.push({ type: 'fail' }); }],
  ['nonempty attempt errors', value => { attempt(value.report).errors.push({ message: 'teardown failed' }); }],
  ['singular attempt error', value => { attempt(value.report).error = { message: 'worker failed' }; }],
  ['global teardown error', value => { value.report.errors.push({ message: 'global teardown failed' }); }],
  ['missing global errors proof', value => { delete value.report.errors; }],
  ['configured workers greater than one', value => { value.report.config.workers = 2; }],
  ['actual workers greater than one', value => { value.report.config.metadata.actualWorkers = 2; }],
  ['replacement worker', value => { attempt(value.report).workerIndex = 1; }],
  ...['1', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined].map(index =>
    [`invalid worker index ${String(index)} (${typeof index})`, value => { attempt(value.report).workerIndex = index; }]),
  ...['0', 1, 0.5, undefined].map(index =>
    [`invalid parallel index ${String(index)} (${typeof index})`, value => { attempt(value.report).parallelIndex = index; }]),
  ...[undefined, 0, 'not-a-date', '2026-09-30', '2026-09-30T19:00:00Z'].map(start =>
    [`invalid test timestamp ${String(start)}`, value => { attempt(value.report).startTime = start; }]),
  ...[undefined, '500', -1, NaN, Infinity, 1e100].map(duration =>
    [`invalid test duration ${String(duration)}`, value => { attempt(value.report).duration = duration; }]),
  ...[undefined, 'not-a-date', '2026-09-30'].map(start =>
    [`invalid report timestamp ${String(start)}`, value => { value.report.stats.startTime = start; }]),
  ...[undefined, '5000', -1, NaN, Infinity, 1e100].map(duration =>
    [`invalid report duration ${String(duration)}`, value => { value.report.stats.duration = duration; }]),
  ['missing actual worker proof', value => { delete value.report.config.metadata; }],
  ['focused tests allowed', value => { value.report.config.forbidOnly = false; }],
  ['sharded selection', value => { value.selection.config.shard = { current: 1, total: 2 }; }],
  ['automatic local server', value => { value.report.config.webServer = { command: 'npm run dev' }; }],
  ['incomplete statistics', value => { value.report.stats.expected = 1; }],
  ['skipped statistics', value => { value.report.stats.skipped = 1; }],
  ['flaky statistics', value => { value.report.stats.flaky = 1; }],
  ['unexpected statistics', value => { value.report.stats.unexpected = 1; }],
]) test(`strict browser proof rejects ${name}`, () => {
  const value = fixture(); mutate(value);
  assert.throws(() => verify(value), /Incomplete disposable browser proof/);
});

test('CLI retains controller identity and byte hashes of manifest, selection and execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'development-browser-report-'));
  try {
    const value = fixture(), paths = ['manifest', 'selection', 'report'].map(name => join(root, `${name}.json`));
    ['manifest', 'selection', 'report'].forEach((name, index) => writeFileSync(paths[index], JSON.stringify(value[name])));
    const candidateSha = 'a'.repeat(40), runId = 'private-fixture';
    const result = spawnSync(process.execPath, ['scripts/verify-development-browser-report.mjs', '--complete', paths[0], 'fullstack', paths[1], paths[2], candidateSha, runId], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.candidateSha, candidateSha); assert.equal(proof.runId, runId); assert.equal(proof.releaseQualified, false);
    for (const [index, name] of ['manifestSha256', 'selectionSha256', 'reportSha256'].entries()) {
      assert.equal(proof[name], createHash('sha256').update(readFileSync(paths[index])).digest('hex'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
