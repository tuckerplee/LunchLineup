import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MOCK_SERVERS } from './fixed-mock-ux.mjs';
import { NEXT_NINE_CASES } from './fixed-mock-ux-next-nine-cases.mjs';

const MOCK_CASES = [{"file":"authenticated-mobile-layout.spec.ts","titlePath":["authenticated-mobile-layout.spec.ts","Authenticated mobile dashboard layout","keeps the permission-aware manager shell reachable at 375px"],"project":"chromium"},{"file":"authenticated-mobile-layout.spec.ts","titlePath":["authenticated-mobile-layout.spec.ts","Authenticated mobile dashboard layout","keeps the permission-aware manager shell reachable at 768px"],"project":"chromium"},{"file":"frontend-accessibility.spec.ts","titlePath":["frontend-accessibility.spec.ts","Frontend accessibility launch contracts","submits onboarding steps with Enter and focuses validation errors"],"project":"chromium"},{"file":"frontend-accessibility.spec.ts","titlePath":["frontend-accessibility.spec.ts","Frontend accessibility launch contracts","operates dashboard dialogs, settings tabs, pack labels, and mobile sign-out by keyboard"],"project":"chromium"},{"file":"tenant-mobile-long-content.spec.ts","titlePath":["tenant-mobile-long-content.spec.ts","Tenant long-content mobile layout","keeps long tenant identity, complete summaries and paged context readable without writes at 320px"],"project":"chromium"},{"file":"tenant-mobile-long-content.spec.ts","titlePath":["tenant-mobile-long-content.spec.ts","Tenant long-content mobile layout","keeps long tenant identity, complete summaries and paged context readable without writes at 393px"],"project":"chromium"},{"file":"tenant-mobile-long-content.spec.ts","titlePath":["tenant-mobile-long-content.spec.ts","Tenant long-content mobile layout","keeps long tenant identity, complete summaries and paged context readable without writes at 768px"],"project":"chromium"},{"file":"tenant-mobile-long-content.spec.ts","titlePath":["tenant-mobile-long-content.spec.ts","Tenant long-content mobile layout","keeps long tenant identity, complete summaries and paged context readable without writes at 1280px"],"project":"chromium"}];

function requireProof(condition, message) {
  if (!condition) throw new Error(`Incomplete disposable browser proof: ${message}`);
}

const key = value => JSON.stringify([value.file, value.titlePath, value.project]);
const forbiddenAnnotation = annotations => !Array.isArray(annotations) || annotations.some(value =>
  !value || typeof value.type !== 'string' || ['skip', 'fixme', 'fail'].includes(value.type));

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  requireProof(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'missing/invalid execution timestamp');
  return parsed;
}

function verifyWorkerLifecycles(executions, stats) {
  const reportStart = timestamp(stats?.startTime);
  requireProof(typeof stats.duration === 'number' && Number.isFinite(stats.duration) && stats.duration >= 0,
    'missing/invalid report duration');
  const reportEnd = reportStart + stats.duration;
  requireProof(Number.isFinite(new Date(reportEnd).getTime()), 'invalid report interval');
  const projects = new Set();
  let worker = -1, project, previousEnd = reportStart;
  // JSON suites are grouped by source, not necessarily execution order.
  for (const execution of [...executions].sort((a, b) => a.start - b.start)) {
    requireProof(execution.start >= previousEnd && execution.end <= reportEnd,
      'overlapping/out-of-report execution');
    if (execution.worker !== worker) {
      // Playwright replaces a process when the project's worker fixture hash changes.
      // These reviewed lanes permit one process lifecycle per selected project.
      requireProof(execution.worker === worker + 1 && !projects.has(execution.project),
        'restarted/reused/unaccounted worker lifecycle');
      worker = execution.worker;
      project = execution.project;
      projects.add(project);
    }
    requireProof(execution.project === project, 'worker reused across projects');
    previousEnd = execution.end;
  }
}

function verifyMockWorkerLifecycles(executions, stats) {
  const expected = MOCK_CASES;
  const sorted = [...executions].sort((a, b) => a.start - b.start);
  requireProof(sorted.length === 8, 'mock lifecycle case count');
  let end = timestamp(stats?.startTime);
  requireProof(Number.isFinite(stats?.duration) && stats.duration >= 0, 'mock report duration');
  const reportEnd = end + stats.duration;
  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index];
    requireProof(key(row) === key(expected[index]) && row.worker === (index < 4 ? 0 : 1) &&
      row.start >= end && row.end <= reportEnd, 'mock worker/group order, restart, gap or overlap');
    end = row.end;
  }
}
function verifyNextNineWorkerLifecycles(executions, stats) {
  const sorted = [...executions].sort((a, b) => a.start - b.start);
  requireProof(sorted.length === NEXT_NINE_CASES.length, 'next-nine lifecycle count');
  let end = timestamp(stats?.startTime);
  requireProof(Number.isFinite(stats?.duration) && stats.duration >= 0, 'next-nine report duration');
  const reportEnd = end + stats.duration;
  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index];
    requireProof(key(row) === key(NEXT_NINE_CASES[index]) && row.worker === (index < 5 ? 0 : 1) &&
      row.start >= end && row.end <= reportEnd, 'next-nine fixture group/restart/order/overlap');
    end = row.end;
  }
  return { guardedWorker: sorted[5].worker, first: sorted[5], last: sorted.at(-1), reportEnd };
}

function verifyNextNineSettlement(report, lifetimes, directory) {
  requireProof(typeof directory === 'string' && resolve(directory) === directory, 'next-nine evidence directory');
  const projects = report.config.projects.filter(value => value.name === 'chromium');
  requireProof(projects.length === 1 && resolve(projects[0].outputDir) === directory,
    'next-nine guarded output binding');
  const name = `qa-loopback-proxy-${lifetimes.guardedWorker}.json`;
  requireProof(JSON.stringify(readdirSync(directory).filter(value => /^qa-loopback-proxy-.*\.json$/.test(value))) ===
    JSON.stringify([name]), 'missing/extra/restarted guarded proxy ledger');
  const path = resolve(directory, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let body;
  try {
    const before = fstatSync(fd);
    requireProof(before.isFile() && before.nlink === 1 && before.uid === process.getuid() &&
      before.size > 0 && before.size <= 65536, 'guarded proxy ledger identity/size');
    body = readFileSync(fd);
    const after = fstatSync(fd);
    requireProof(body.length === before.size && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(name =>
      before[name] === after[name]), 'guarded proxy ledger changed');
  } finally { closeSync(fd); }
  const value = JSON.parse(body);
  const started = timestamp(value.startedAt), stopped = timestamp(value.stoppedAt);
  requireProof(value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    value.approvedOrigin === 'http://127.0.0.1:8080' &&
    value.upstream?.hostname === '127.0.0.1' && value.upstream.port === 8080 &&
    /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(value.listenOrigin) &&
    Number.isSafeInteger(value.approvedConnects) && value.approvedConnects >= 0 &&
    value.openUpstreamSockets === 0 && value.socketsClosed === true &&
    Array.isArray(value.denials) && value.denials.length === 0 &&
    Array.isArray(value.policyDenials) && value.policyDenials.length === 0 &&
    started >= timestamp(report.stats.startTime) && started <= lifetimes.first.end &&
    stopped >= started && stopped >= lifetimes.last.start && stopped <= lifetimes.reportEnd,
    'actual guarded worker proxy/fixture settlement');
  // Existing guarded auto-fixture teardown errors fail the corresponding case;
  // the exact all-pass report plus this worker-indexed ledger proves both paths.
  return { guardedWorker: lifetimes.guardedWorker, pid: value.pid, path, bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'), socketsClosed: true,
    openUpstreamSockets: 0, policyDenials: 0, proxyDenials: 0, stoppedAt: value.stoppedAt };
}

function mockServerContract(report, nextNine = false) {
  const value = report.config?.metadata?.fixedMockUx;
  requireProof(value?.kind === (nextNine ? 'fixed-nine-mock-ux' : 'fixed-eight-mock-ux') && value.concurrency === 1 && value.expectedWorkerLifetimes === 2 &&
    value.servingMode === 'production' &&
    value.traces === 'on' && value.chromiumSandbox === true &&
    JSON.stringify(value.servers) === JSON.stringify(MOCK_SERVERS),
    'mock fixed server/worker contract');
  if (report.config.webServer != null) {
    requireProof(Array.isArray(report.config.webServer) &&
      JSON.stringify(report.config.webServer.map(({ command, url, reuseExistingServer, timeout }) =>
        ({ command, url, reuseExistingServer, timeout }))) === JSON.stringify(MOCK_SERVERS),
      'mock config-owned server mismatch');
  }
}

function cases(report, executed, mockUx = false, proxyDirectory, settlement) {
  requireProof(Array.isArray(report?.errors) && report.errors.length === 0, 'global report errors');
  requireProof(report.config?.workers === 1 && report.config?.forbidOnly === true &&
    report.config?.shard == null && (mockUx || report.config?.webServer == null), 'worker/focus/shard/server policy');
  if (mockUx) mockServerContract(report, mockUx === 'next-nine');
  requireProof(Array.isArray(report.config.projects), 'project configuration');
  if (executed) requireProof(report.config.metadata?.actualWorkers === 1, 'actual concurrent worker count');
  const rows = [];
  const executions = [];
  const ids = new Set();
  function visit(suites, parents = []) {
    requireProof(Array.isArray(suites), 'suite inventory');
    for (const suite of suites) {
      requireProof(suite && typeof suite.title === 'string' && Array.isArray(suite.specs), 'suite shape');
      const titlePath = [...parents, suite.title];
      for (const spec of suite.specs) {
        requireProof(typeof spec.file === 'string' && typeof spec.title === 'string' &&
          typeof spec.id === 'string' && spec.id.length > 0 && !ids.has(spec.id), 'missing/duplicate spec identity');
        ids.add(spec.id);
        requireProof(spec.ok === true && Array.isArray(spec.tests) && spec.tests.length === 1, 'spec outcome/project multiplicity');
        const test = spec.tests[0];
        requireProof(test.expectedStatus === 'passed' && !forbiddenAnnotation(test.annotations), 'expected failure/skip annotation');
        requireProof(typeof test.projectName === 'string' && test.projectId === test.projectName, 'project identity');
        const projects = report.config.projects.filter(project => project.name === test.projectName);
        requireProof(projects.length === 1 && projects[0].id === test.projectId &&
          projects[0].retries === 0 && projects[0].repeatEach === 1, 'project/retry/repeat policy');
        requireProof(Array.isArray(test.results), 'result inventory');
        if (executed) {
          requireProof(test.status === 'expected' && test.results.length === 1, 'missing/repeated/nonpassing execution');
          const result = test.results[0];
          requireProof(result.status === 'passed' && result.retry === 0 &&
            Number.isSafeInteger(result.workerIndex) && result.workerIndex >= 0 &&
            result.parallelIndex === 0 && Array.isArray(result.errors) && result.errors.length === 0 &&
            result.error == null && !forbiddenAnnotation(result.annotations), 'failed/retried/error-bearing execution');
          const start = timestamp(result.startTime);
          requireProof(typeof result.duration === 'number' && Number.isFinite(result.duration) && result.duration >= 0,
            'missing/invalid execution duration');
          const end = start + result.duration;
          requireProof(Number.isFinite(new Date(end).getTime()), 'invalid execution interval');
          executions.push({ file: spec.file, titlePath: [...titlePath, spec.title], project: test.projectName, worker: result.workerIndex, start, end });
        } else {
          // Playwright's --list JSON reports each unexecuted case as skipped.
          // Execution must independently pass the checks above.
          requireProof(test.status === 'skipped' && test.results.length === 0, 'selection unexpectedly contains execution');
        }
        rows.push({ file: spec.file, titlePath: [...titlePath, spec.title], project: test.projectName, id: spec.id, tags: spec.tags });
      }
      if (suite.suites !== undefined) visit(suite.suites, titlePath);
    }
  }
  visit(report.suites);
  requireProof(rows.length > 0 && new Set(rows.map(key)).size === rows.length, 'empty/duplicate selected cases');
  if (executed && mockUx === 'next-nine') {
    const lifetimes = verifyNextNineWorkerLifecycles(executions, report.stats);
    settlement.proof = verifyNextNineSettlement(report, lifetimes, proxyDirectory);
  } else if (executed) (mockUx ? verifyMockWorkerLifecycles : verifyWorkerLifecycles)(executions, report.stats);
  if (!executed) requireProof(report.stats?.expected === 0 && report.stats.skipped === rows.length &&
    report.stats.unexpected === 0 && report.stats.flaky === 0, 'inconsistent unexecuted selection summary');
  return rows;
}

export function verifyDevelopmentSelection(manifest, lane, selection) {
  requireProof(manifest?.version === 1 && manifest.releaseQualified === false &&
    Object.hasOwn(manifest.lanes ?? {}, lane), 'manifest identity');
  const expected = manifest.lanes[lane];
  requireProof(Array.isArray(expected) && expected.length > 0 && expected.every(value =>
    typeof value.file === 'string' && typeof value.project === 'string' &&
    Array.isArray(value.titlePath) && value.titlePath.length > 0 && value.titlePath.every(title => typeof title === 'string')) &&
    new Set(expected.map(key)).size === expected.length, 'invalid/duplicate expected cases');
  const mockUx = lane === 'mock-ux-next-nine' ? 'next-nine' : lane === 'mock-ux';
  if (mockUx) requireProof(JSON.stringify(expected) === JSON.stringify(mockUx === 'next-nine' ? NEXT_NINE_CASES : MOCK_CASES), 'fixed mock identities');
  const selected = cases(selection, false, mockUx);
  const expectedKeys = new Set(expected.map(key));
  requireProof(selected.length === expected.length && selected.every(value => expectedKeys.has(key(value))), 'selection differs from reviewed manifest');
  if (lane === 'fullstack') requireProof(selected.every(value => Array.isArray(value.tags) && value.tags.includes('full-stack')), 'native acceptance tag');
  return selected;
}

export function verifyDevelopmentBrowserReport(manifest, lane, selection, report, proxyDirectory) {
  const selected = verifyDevelopmentSelection(manifest, lane, selection);
  const mockUx = lane === 'mock-ux' || lane === 'mock-ux-next-nine';
  if (mockUx) requireProof(JSON.stringify(selection.config.metadata.fixedMockUx) ===
    JSON.stringify(report.config?.metadata?.fixedMockUx), 'mock source/run contract changed after selection');
  const settlement = {};
  const actual = cases(report, true, lane === 'mock-ux-next-nine' ? 'next-nine' : lane === 'mock-ux', proxyDirectory, settlement);
  const selectedIds = new Map(selected.map(value => [key(value), value.id]));
  requireProof(actual.length === selected.length && actual.every(value => selectedIds.get(key(value)) === value.id), 'execution differs from selected cases');
  if (lane === 'fullstack') {
    requireProof(actual.every(value => Array.isArray(value.tags) && value.tags.includes('full-stack')), 'native execution tag');
    requireProof(new Set(actual.map(value => value.project)).size === 1, 'native execution project multiplicity');
  }
  const stats = report.stats;
  requireProof(stats?.expected === selected.length && stats.unexpected === 0 && stats.skipped === 0 && stats.flaky === 0, 'incomplete summary');
  return { kind: 'exact-disposable-development-browser-report', releaseQualified: false, lane,
    passed: true, selected: selected.length, executed: actual.length, workers: 1, retries: 0,
    ...(lane === 'mock-ux-next-nine' ? { fixtureSettlement: settlement.proof } : {}),
    ...(mockUx ? { actualWorkers: 1, workerLifetimes: 2,
      fixedServerContract: report.config.metadata.fixedMockUx } : {}),
    cases: actual.map(({ tags: _tags, ...value }) => value) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, manifestPath, lane, selectionPath, reportPath, candidateSha, runId, proxyDirectory] = process.argv.slice(2);
  requireProof((mode === '--selection' && process.argv.length === 6) ||
    (mode === '--complete' && process.argv.length === 9 && lane !== 'mock-ux-next-nine') ||
    (mode === '--complete-next-nine' && process.argv.length === 10 && lane === 'mock-ux-next-nine'), 'CLI arguments');
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const manifest = read(manifestPath), selection = read(selectionPath);
  if (mode === '--selection') {
    console.log(JSON.stringify({ releaseQualified: false, lane, selected: verifyDevelopmentSelection(manifest, lane, selection).length }));
  } else {
    requireProof(/^[a-f0-9]{40}$/.test(candidateSha) && /^[a-zA-Z0-9-]+$/.test(runId), 'controller identity');
    const proof = verifyDevelopmentBrowserReport(manifest, lane, selection, read(reportPath), proxyDirectory);
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    if (lane === 'mock-ux' || lane === 'mock-ux-next-nine') requireProof(proof.fixedServerContract.sourceSha === candidateSha &&
      proof.fixedServerContract.runId === runId && proof.fixedServerContract.selectionSha256 === digest(manifestPath),
      'mock report candidate/run/manifest binding');
    console.log(JSON.stringify({ ...proof, candidateSha, runId, manifestSha256: digest(manifestPath),
      selectionSha256: digest(selectionPath), reportSha256: digest(reportPath) }));
  }
}
