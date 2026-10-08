// A closed cohort extension of the existing migration runner, not a generic executor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runBoundedProcess } from './bounded-child-process.mjs';
import { readFixedBrowserSourceProfile } from './fixed-browser-source-profile.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const selectionPath = '.ci/development-c08-cases.json';
const identities = [
  ['tests/deploy/observability-configs.test.mjs', 'observability container mode runs the real pinned config and rule validators', 240000, 250000],
  ['tests/migration/legacy-unbacked-credit-cleanup.integration.test.mjs', 'legacy unbacked credit cleanup is selective, fail-closed, and replay-safe in PostgreSQL', 120000, 130000],
  ['tests/migration/staff-invitation-outbox.integration.test.mjs', 'populated old schema gains tenant-first User identity and enforced composite invitation FK', 120000, 130000],
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateC08Selection(selection) {
  assert.equal(selection.kind, 'lunchlineup-fixed-c08-container-selection');
  assert.equal(selection.version, 1);
  assert.equal(selection.releaseQualified, false);
  assert.equal(selection.fileCount, 3);
  assert.equal(selection.selectedCaseCount, 3);
  assert.equal(selection.aggregateRuntimeTimeoutMs, 600000);
  assert.equal(selection.concurrency, 1);
  assert.equal(selection.retry, false);
  assert.deepEqual(selection.cases.map((entry) => [entry.file, entry.title, entry.timeoutMs, entry.outerTimeoutMs]), identities);
  for (const entry of selection.cases) {
    assert.equal(entry.expectedPass, 1);
    assert.equal(entry.expectedSelectedSkip, 0);
    assert.match(entry.sourcePin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.sourcePin.bytes) && entry.sourcePin.bytes > 0);
  }
  assert.deepEqual(Object.keys(selection.images).sort(), ['alertmanager', 'caddy', 'otel', 'postgres', 'prometheus']);
  for (const image of Object.values(selection.images)) assert.match(image, /^[^\s]+@sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(selection.images)).size, 5);
  return selection;
}

export function validateC08Events(events, selected) {
  let passes = 0;
  for (const event of events) {
    if (event.type === 'test:fail') throw new Error('C08 test failure: ' + event.data?.name);
    if (event.type !== 'test:pass') continue;
    const data = event.data;
    const sameTitle = data.name === selected.title;
    // Node versions can report name-filtered definitions as excluded. They are
    // never counted; a selected skip (including Docker unavailable) always fails.
    if (!sameTitle && data.skip === 'test name does not match pattern') continue;
    assert.equal(data.name, selected.title, 'Unexpected C08 executed test');
    assert.ok(data.file && resolve(data.file) === resolve(root, selected.file), 'C08 test file identity mismatch');
    assert.ok(!data.skip && !data.todo && !data.details?.error, 'C08 selected case skipped/todo/failed');
    passes += 1;
  }
  assert.equal(passes, 1, 'C08 requires exactly one selected passing case per file');
  return { file: selected.file, title: selected.title, pass: 1, skip: 0 };
}

// Node's built-in reporter API preserves machine-readable individual outcomes;
// raw events are retained even when the child or owner fails.
export default async function* c08Reporter(source) {
  for await (const event of source) yield JSON.stringify(event, (_key, value) => {
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (value instanceof Error) return { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause };
    return value;
  }) + '\n';
}

function ownerPhase(env) {
  const result = spawnSync('python3', [join(root, 'scripts/read-fixed-browser-phase.py'), '--c08-json'], {
    env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, `C08 owner phase refused: ${result.stderr}`);
  const phase = JSON.parse(result.stdout);
  assert.equal(phase.cohort, 'c08');
  assert.equal(phase.version, 2);
  assert.ok(['acquisition', 'runtime'].includes(phase.phase));
  assert.equal(phase.buildRoot, root);
  return phase;
}

export async function runFixedC08(args) {
  assert.deepEqual(args, ['--fixed-container-selection', selectionPath], 'Only the fixed C08 selection is supported');
  const env = { ...process.env };
  const contextPath = `${env.RUNNER_TEMP}/lunchlineup-source-${env.CI_RUN_ID}/source-context.json`;
  const profile = readFixedBrowserSourceProfile({ contextPath }, env);
  assert.equal(profile?.pipelinePath, '.ci/development-c08.pipeline.json', 'C08 requires authenticated source profile');
  const phase = ownerPhase(env);
  const bytes = readFileSync(join(root, selectionPath));
  assert.equal(digest(bytes), phase.selectionSha256);
  assert.equal(profile.pipelineSha256, phase.pipelineSha256);
  const selection = validateC08Selection(JSON.parse(bytes));
  for (const entry of selection.cases) {
    const body = readFileSync(join(root, entry.file));
    assert.equal(body.length, entry.sourcePin.bytes);
    assert.equal(digest(body), entry.sourcePin.sha256, 'C08 selected source changed');
  }
  env.LUNCHLINEUP_DEV_RUNTIME = phase.runtimeDirectory;
  env.PATH = join(root, 'scripts/ci-container-bin') + ':' + env.PATH;
  const adapter = join(root, 'scripts/ci-container-bin/docker');
  const qualification = join(env.RUNNER_TEMP, 'lunchlineup-beta-qualification-' + env.CI_RUN_ID);
  const command = async (args, timeoutMs = 110000) => runBoundedProcess(adapter, args, {
    cwd: root, env, timeoutMs, label: 'fixed C08 ' + args[0],
  });
  if (phase.phase === 'acquisition') {
    mkdirSync(qualification, { mode: 0o700 });
    writeFileSync(join(qualification, 'c08-selection.json'), bytes, { flag: 'wx', mode: 0o600 });
    for (const image of Object.values(selection.images)) await command(['pull', image]);
    return; // Root owner independently checks images and seals selection.
  }
  assert.equal(digest(readFileSync(join(qualification, 'c08-selection.json'))), phase.selectionSha256);
  const evidence = join(env.CI_WORKSPACE, '.release/internal-ci', profile.sourceSha, 'c08');
  mkdirSync(evidence, { mode: 0o700, recursive: true });
  const result = { version: 1, runId: env.CI_RUN_ID, sourceSha: profile.sourceSha,
    pipelineSha256: phase.pipelineSha256, selectionSha256: phase.selectionSha256,
    cases: [], applicationPassed: false, cleanupPassed: false, releaseQualified: false };
  const deadline = Date.now() + selection.aggregateRuntimeTimeoutMs;
  let failure;
  let networkCreated = false;
  try {
    await command(['c08-network-create'], 40000);
    networkCreated = true;
    for (const [index, entry] of selection.cases.entries()) {
      result.activeCase = { file: entry.file, title: entry.title };
      const log = join(evidence, `case-${index + 1}.events.jsonl`);
      const stderr = join(evidence, `case-${index + 1}.stderr.log`);
      const outputFd = openSync(log, 'wx', 0o600), errorFd = openSync(stderr, 'wx', 0o600);
      try {
        const remaining = Math.min(entry.outerTimeoutMs, deadline - Date.now());
        assert.ok(remaining > 0, 'C08 aggregate deadline exhausted');
        await runBoundedProcess(process.execPath, ['--test', '--test-concurrency=1',
          '--test-name-pattern=^' + escapeRegex(entry.title) + '$',
          '--test-reporter=' + fileURLToPath(import.meta.url), entry.file], {
          cwd: root, env, timeoutMs: remaining, stdio: ['ignore', outputFd, errorFd], label: 'C08 ' + entry.file,
        });
      } finally { closeSync(outputFd); closeSync(errorFd); }
      const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      result.cases.push(validateC08Events(events, entry));
    }
    assert.equal(result.cases.length, 3);
    result.applicationPassed = true;
    delete result.activeCase;
  } catch (error) {
    failure = error;
    result.failure = String(error);
  } finally {
    try {
      if (networkCreated) { await command(['c08-cleanup'], 110000); result.cleanupPassed = true; }
    }
    catch (error) { result.cleanupFailure = String(error); failure ??= error; }
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw failure;
}
