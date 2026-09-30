import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function requireProof(condition, message) {
  if (!condition) throw new Error(`Incomplete disposable browser proof: ${message}`);
}

const key = value => JSON.stringify([value.file, value.titlePath, value.project]);
const forbiddenAnnotation = annotations => !Array.isArray(annotations) || annotations.some(value =>
  !value || typeof value.type !== 'string' || ['skip', 'fixme', 'fail'].includes(value.type));

function cases(report, executed) {
  requireProof(Array.isArray(report?.errors) && report.errors.length === 0, 'global report errors');
  requireProof(report.config?.workers === 1 && report.config?.forbidOnly === true &&
    report.config?.shard == null && report.config?.webServer == null, 'worker/focus/shard/server policy');
  requireProof(Array.isArray(report.config.projects), 'project configuration');
  if (executed) requireProof(report.config.metadata?.actualWorkers === 1, 'actual worker count');
  const rows = [];
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
          requireProof(result.status === 'passed' && result.retry === 0 && result.workerIndex === 0 &&
            result.parallelIndex === 0 && Array.isArray(result.errors) && result.errors.length === 0 &&
            result.error == null && !forbiddenAnnotation(result.annotations), 'failed/retried/error-bearing execution');
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
  const selected = cases(selection, false);
  const expectedKeys = new Set(expected.map(key));
  requireProof(selected.length === expected.length && selected.every(value => expectedKeys.has(key(value))), 'selection differs from reviewed manifest');
  if (lane === 'fullstack') requireProof(selected.every(value => Array.isArray(value.tags) && value.tags.includes('full-stack')), 'native acceptance tag');
  return selected;
}

export function verifyDevelopmentBrowserReport(manifest, lane, selection, report) {
  const selected = verifyDevelopmentSelection(manifest, lane, selection);
  const actual = cases(report, true);
  const selectedIds = new Map(selected.map(value => [key(value), value.id]));
  requireProof(actual.length === selected.length && actual.every(value => selectedIds.get(key(value)) === value.id), 'execution differs from selected cases');
  if (lane === 'fullstack') requireProof(actual.every(value => Array.isArray(value.tags) && value.tags.includes('full-stack')), 'native execution tag');
  const stats = report.stats;
  requireProof(stats?.expected === selected.length && stats.unexpected === 0 && stats.skipped === 0 && stats.flaky === 0, 'incomplete summary');
  return { kind: 'exact-disposable-development-browser-report', releaseQualified: false, lane,
    passed: true, selected: selected.length, executed: actual.length, workers: 1, retries: 0,
    cases: actual.map(({ tags: _tags, ...value }) => value) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, manifestPath, lane, selectionPath, reportPath, candidateSha, runId] = process.argv.slice(2);
  requireProof((mode === '--selection' && process.argv.length === 6) ||
    (mode === '--complete' && process.argv.length === 9), 'CLI arguments');
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const manifest = read(manifestPath), selection = read(selectionPath);
  if (mode === '--selection') {
    console.log(JSON.stringify({ releaseQualified: false, lane, selected: verifyDevelopmentSelection(manifest, lane, selection).length }));
  } else {
    requireProof(/^[a-f0-9]{40}$/.test(candidateSha) && /^[a-zA-Z0-9-]+$/.test(runId), 'controller identity');
    const proof = verifyDevelopmentBrowserReport(manifest, lane, selection, read(reportPath));
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    console.log(JSON.stringify({ ...proof, candidateSha, runId, manifestSha256: digest(manifestPath),
      selectionSha256: digest(selectionPath), reportSha256: digest(reportPath) }));
  }
}
