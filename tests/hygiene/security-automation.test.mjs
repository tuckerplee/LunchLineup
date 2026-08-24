import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const codeqlActionSha = '641a925cfafe92d0fdf8b239ba4053e3f8d99d6d';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function load(path) {
  return yaml.load(read(path));
}

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name);
}

test('historical GitHub scanner definitions remain reviewable but non-executable', () => {
  const source = read('docs/legacy/github-actions-ci.yml');
  const workflow = load('docs/legacy/github-actions-ci.yml');
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
  assert.match(scan.run, /semgrep scan --config p\/default --baseline-commit origin\/main --error --sarif --output semgrep\.sarif/);

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

  const nodeSetup = stepByName(codeql, 'Set up Node for TypeScript extraction');
  assert.equal(nodeSetup.if, "matrix.language == 'javascript-typescript'");
  assert.match(nodeSetup.uses, /^actions\/setup-node@[a-f0-9]{40}$/);
  assert.equal(nodeSetup.with['node-version'], '22');

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

test('internal appliance executes dependency and release qualification gates while GitHub scheduling stays disabled', () => {
  const workflow = load('docs/legacy/github-actions-ci.yml');
  const internalPipeline = JSON.parse(read('.ci/pipeline.json'));
  const dependencyReview = workflow.jobs['dependency-audit'].steps.find(
    (step) => step.uses?.startsWith('actions/dependency-review-action@'),
  );
  const requiredStepNames = [
    'Materialize and verify exact candidate source', 'Install locked JavaScript dependencies',
    'Dependency audit', 'License policy', 'Lint', 'Typecheck', 'Migration and hygiene tests',
    'Observability validation', 'Terraform validation', 'Semgrep full inventory',
    'Semgrep baseline delta', 'CodeQL JavaScript/TypeScript', 'CodeQL Python',
    'JavaScript unit suites', 'Engine Python unit suite', 'Worker Python unit suite',
    'Source build', 'Mock Playwright', 'Disposable database integration',
    'Canonical beta release-image build', 'Production image inventory', 'Release stack health',
    'DB-backed Playwright', 'Interaction proof', 'DAST', 'Load qualification', 'SBOM', 'Trivy',
    'Artifact integrity manifest', 'Candidate receipt construction',
    'External policy verification and signing', 'Signature self-verification',
  ];

  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(dependencyReview, undefined);
  assert.deepEqual(internalPipeline.triggers.branches, ['internal-beta-candidate']);
  assert.deepEqual(internalPipeline.steps.map(({ name }) => name), requiredStepNames);
  assert.match(internalPipeline.steps[0].run, /materialize-internal-ci-source\.mjs/);
  for (const step of internalPipeline.steps.slice(1)) assert.match(step.run, /scripts\/[A-Za-z0-9._-]+/);
  const serialized = JSON.stringify(internalPipeline);
  assert.doesNotMatch(serialized, /chmod -R a\+rwx|\$PWD:\/src|--source-proof .*record-internal-ci-gate/);
  assert.ok(internalPipeline.steps.find(({ name }) => name === 'Candidate receipt construction').run.includes('build-internal-ci-candidate-receipt.mjs'));
  assert.ok(internalPipeline.steps.find(({ name }) => name === 'External policy verification and signing').run.includes('lunchlineup-sign-receipt'));
  assert.ok(internalPipeline.steps.find(({ name }) => name === 'Signature self-verification').run.includes('verify-internal-ci-candidate-receipt.mjs'));
  assert.ok(internalPipeline.artifacts.includes('.release/internal-ci/**'));

  assert.equal(existsSync(join(root, '.github/dependabot.yml')), false);
  assert.equal(existsSync(join(root, '.github/workflows/ci.yml')), false);
  assert.equal(existsSync(join(root, 'docs/legacy/github-actions-ci.yml')), true);
});

test('all external actions are immutable and CodeQL uses the reviewed source scope', () => {
  const workflowDirectory = join(root, '.github/workflows');
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/.test(file));

  assert.deepEqual(workflowFiles, []);

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
