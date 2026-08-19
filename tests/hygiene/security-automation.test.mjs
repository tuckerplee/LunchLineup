import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const codeqlActionSha = '641a925cfafe92d0fdf8b239ba4053e3f8d99d6d';
const dependencyReviewSha = '2031cfc080254a8a887f58cffee85186f0e49e48';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function load(path) {
  return yaml.load(read(path));
}

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name);
}

test('CI uploads mandatory Semgrep and CodeQL analyses with least privilege', () => {
  const source = read('.github/workflows/ci.yml');
  const workflow = load('.github/workflows/ci.yml');
  const sast = workflow.jobs.sast;
  const codeql = workflow.jobs.codeql;

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.schedule.some((entry) => entry.cron === '23 9 * * 1'));

  assert.deepEqual(sast.permissions, {
    contents: 'read',
    'security-events': 'write',
  });
  assert.doesNotMatch(source, /returntocorp\/semgrep-action/);

  const scan = stepByName(sast, 'Run digest-pinned Semgrep and retain its exit status');
  assert.match(
    scan.env.SEMGREP_IMAGE,
    /^semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/,
  );
  assert.match(scan.run, /--env HOME=\/tmp\/semgrep-home/);
  assert.match(scan.run, /semgrep scan --config p\/default --error --sarif --output semgrep\.sarif/);

  const semgrepUpload = stepByName(sast, 'Upload Semgrep SARIF');
  assert.equal(
    semgrepUpload.uses,
    'github/codeql-action/upload-sarif@' + codeqlActionSha,
  );
  assert.equal(semgrepUpload.with.sarif_file, 'semgrep.sarif');
  assert.equal(semgrepUpload.with['wait-for-processing'], true);
  assert.match(semgrepUpload.if, /always\(\)/);

  const semgrepGate = stepByName(sast, 'Enforce Semgrep result');
  assert.equal(semgrepGate.if, 'always()');
  assert.match(semgrepGate.run, /SEMGREP_EXIT_CODE/);
  assert.equal(sast['continue-on-error'], undefined);

  assert.deepEqual(codeql.permissions, {
    actions: 'read',
    contents: 'read',
    'security-events': 'write',
  });
  assert.equal(codeql.strategy['fail-fast'], false);
  assert.deepEqual(codeql.strategy.matrix.language, ['javascript-typescript', 'python']);

  const init = stepByName(codeql, 'Initialize CodeQL');
  const analyze = stepByName(codeql, 'Analyze and upload CodeQL results');
  assert.equal(init.uses, 'github/codeql-action/init@' + codeqlActionSha);
  assert.equal(init.with['build-mode'], 'none');
  assert.equal(init.with['config-file'], './.github/codeql/codeql-config.yml');
  assert.equal(analyze.uses, 'github/codeql-action/analyze@' + codeqlActionSha);
  assert.equal(analyze.with['wait-for-processing'], true);
  assert.equal(codeql['continue-on-error'], undefined);

  assert.deepEqual(workflow.jobs['unit-tests'].needs, ['static-analysis', 'sast', 'codeql', 'dependency-audit']);
  assert.equal(workflow.jobs['build-images'].needs, 'unit-tests');
});

test('dependency review remains fail-closed and GitHub dependency scheduling stays disabled', () => {
  const workflow = load('.github/workflows/ci.yml');
  const internalPipeline = JSON.parse(read('.ci/pipeline.json'));
  const dependencyReview = workflow.jobs['dependency-audit'].steps.find(
    (step) => step.uses === 'actions/dependency-review-action@' + dependencyReviewSha,
  );
  const internalAudit = internalPipeline.steps.find((step) => step.name === 'Verify production dependency closure');

  assert.ok(dependencyReview);
  assert.equal(dependencyReview.if, "github.event_name == 'pull_request'");
  assert.equal(dependencyReview.with['fail-on-severity'], 'high');
  assert.equal(dependencyReview['continue-on-error'], undefined);
  assert.equal(internalAudit.run, 'npm run audit:prod');
  assert.equal(internalAudit.timeout_seconds, 300);

  assert.equal(existsSync(join(root, '.github/dependabot.yml')), false);
});

test('all external actions are immutable and CodeQL uses the reviewed source scope', () => {
  const workflowDirectory = join(root, '.github/workflows');
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/.test(file));

  const unpinned = [];
  for (const file of workflowFiles) {
    const references = [...read('.github/workflows/' + file).matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)]
      .map((match) => match[1])
      .filter((reference) => !reference.startsWith('./'));

    for (const reference of references) {
      if (!/@[a-f0-9]{40}$/i.test(reference)) unpinned.push(file + ': ' + reference);
    }
  }
  assert.deepEqual(unpinned, []);

  const config = load('.github/codeql/codeql-config.yml');
  assert.deepEqual(config.queries, [{ uses: 'security-extended' }]);
  assert.deepEqual(config.paths, ['apps', 'packages', 'scripts', 'infrastructure']);
  assert.ok(config['paths-ignore'].includes('old'));
});
