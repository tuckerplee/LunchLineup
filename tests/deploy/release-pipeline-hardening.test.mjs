import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { computeDeployedInputsContentDigest } from '../../scripts/deployed-inputs-content-digest.mjs';
import { buildDeploymentContractBundle } from '../../scripts/write-deployment-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function workflowJob(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`  ${jobName}:`);
  const end = workflow.indexOf(`\n  ${nextJobName}:`, start + 1);
  assert.notEqual(start, -1, `missing ${jobName} workflow job`);
  assert.notEqual(end, -1, `missing ${nextJobName} workflow job boundary`);
  return workflow.slice(start, end);
}

test('license policy uses only the locked local executable with registry access disabled', () => {
  const workflow = read('.github/workflows/ci.yml');
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));

  assert.equal(packageJson.devDependencies['license-checker'], '25.0.1');
  assert.equal(packageLock.packages[''].devDependencies['license-checker'], '25.0.1');
  assert.equal(packageLock.packages['node_modules/license-checker'].version, '25.0.1');
  assert.match(workflow, /NPM_CONFIG_OFFLINE: 'true'[\s\S]*test -x \.\/node_modules\/\.bin\/license-checker[\s\S]*\.\/node_modules\/\.bin\/license-checker --failOn/);
  assert.doesNotMatch(workflow, /\bnpx\s+--yes\b/);
});

test('static analysis validates observability configs and Prometheus fixtures in pinned container mode', () => {
  const workflow = read('.github/workflows/ci.yml');
  const staticAnalysis = workflowJob(workflow, 'static-analysis', 'terraform-validation');
  const migration = staticAnalysis.indexOf('- name: "2b. Migration SaaS and hygiene tests"');
  const observability = staticAnalysis.indexOf('- name: "2c. Validate observability configs and Prometheus rule fixtures"');

  assert.ok(migration >= 0 && observability > migration);
  assert.match(
    staticAnalysis,
    /run: node scripts\/verify-observability-configs\.mjs --root \. --tool-mode container/,
  );
});

test('Stage 10 integration tests inherit the migration platform-admin capability', () => {
  const workflow = read('.github/workflows/ci.yml');
  const integration = workflowJob(workflow, 'integration-tests', 'dast');
  const migrationSecret = integration.match(
    /- name: "9\. Run Migrations"[\s\S]*?PLATFORM_ADMIN_DB_CONTEXT_SECRET: ([^\n]+)/,
  )?.[1]?.trim();
  const testSecret = integration.match(
    /- name: "10\. Integration Tests"[\s\S]*?PLATFORM_ADMIN_DB_CONTEXT_SECRET: ([^\n]+)/,
  )?.[1]?.trim();

  assert.ok(migrationSecret);
  assert.equal(testSecret, migrationSecret);
  assert.match(integration, /- name: "10\. Integration Tests"[\s\S]*run: npm run test:integration/);
});

test('mandatory integration gates pull requests, develop pushes, and main without publishing non-main images', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml'));
  const integration = workflow.jobs['integration-tests'];
  const buildImages = workflow.jobs['build-images'];
  const mainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const runsFor = (job, eventName, ref) => {
    if (!Object.hasOwn(job, 'if')) return true;
    assert.equal(job.if, mainOnly);
    return eventName === 'push' && ref === 'refs/heads/main';
  };

  assert.deepEqual(workflow.on.pull_request.branches, ['main', 'develop']);
  assert.deepEqual(workflow.on.push.branches, ['main', 'develop']);
  assert.equal(integration.needs, 'unit-tests');
  assert.equal(buildImages.needs, 'unit-tests');
  assert.equal(buildImages.if, mainOnly);

  assert.equal(runsFor(integration, 'pull_request', 'refs/pull/1/merge'), true);
  assert.equal(runsFor(integration, 'push', 'refs/heads/develop'), true);
  assert.equal(runsFor(integration, 'push', 'refs/heads/main'), true);
  assert.equal(runsFor(buildImages, 'pull_request', 'refs/pull/1/merge'), false);
  assert.equal(runsFor(buildImages, 'push', 'refs/heads/develop'), false);
  assert.equal(runsFor(buildImages, 'push', 'refs/heads/main'), true);
});

test('deployment contract bundle retains every release Dockerfile', () => {
  const { bytes, contract } = buildDeploymentContractBundle(root);
  const bundle = JSON.parse(bytes.toString('utf8'));
  const bundledPaths = new Set(bundle.files.map((file) => file.path));
  const dockerfiles = readdirSync(resolve(root, 'infrastructure/docker'))
    .filter((name) => name.startsWith('Dockerfile.'))
    .map((name) => `infrastructure/docker/${name}`);

  for (const dockerfile of dockerfiles) {
    assert.ok(bundledPaths.has(dockerfile), `bundle omits ${dockerfile}`);
    assert.match(contract.files[dockerfile], /^[a-f0-9]{64}$/);
  }
});

test('deployment contract is an exact secret-free compatibility and rollback source archive', () => {
  const { bytes, contract } = buildDeploymentContractBundle(root);
  const bundle = JSON.parse(bytes.toString('utf8'));
  const paths = bundle.files.map((file) => file.path);
  const pathSet = new Set(paths);

  assert.equal(bundle.version, 2);
  assert.equal(contract.bundle.format, 'lunchlineup-deployment-contract-json-v2');
  assert.equal(contract.retention.profile, 'lunchlineup-release-rollback-compatibility-v2');
  assert.equal(contract.retention.pathCount, paths.length);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(Object.keys(contract.files), paths);
  assert.deepEqual(contract.retention.groups.integrationTests, paths.filter((path) => path.startsWith('tests/integration/') && path.endsWith('.test.mjs')));
  assert.deepEqual(contract.retention.groups.systemdUnits, paths.filter((path) => path.startsWith('infrastructure/systemd/') && /\.(?:service|timer)$/.test(path)));

  for (const required of [
    'package.json',
    'package-lock.json',
    'apps/api/package.json',
    'apps/control-plane/package.json',
    'apps/web/package.json',
    'packages/config/package.json',
    'packages/db/package.json',
    'packages/rbac/package.json',
    'packages/testing/package.json',
    'apps/engine/requirements.txt',
    'apps/worker/requirements.txt',
    'packages/db/prisma/schema.prisma',
    'scripts/old-release-compatibility-harness.mjs',
    'scripts/verify-backup-readiness.sh',
    'infrastructure/systemd/lunchlineup-backup.service',
    'infrastructure/systemd/lunchlineup-backup.timer',
    'infrastructure/systemd/lunchlineup-pitr-base-backup.service',
    'infrastructure/systemd/lunchlineup-pitr-base-backup.timer',
  ]) assert.ok(pathSet.has(required), `retained archive omits ${required}`);

  for (const forbidden of paths) {
    assert.doesNotMatch(forbidden, /(?:^|\/)(?:node_modules|\.next|\.release|\.terraform|dist|coverage)(?:\/|$)/);
    assert.doesNotMatch(forbidden, /(?:^|\/)\.env(?:\.production)?$/);
    assert.doesNotMatch(forbidden, /\.(?:key|p12|pem|pyc|sigstore\.json|tar|tgz|zip)$/i);
  }
});

test('release CI requires every retained archive input to be tracked', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(
    workflow,
    /deployment_contract="\$\(RELEASE_REQUIRE_TRACKED_INPUTS=true node scripts\/write-deployment-contract\.mjs --bundle-output \.release\/deployment-contract\.bundle\.json\)"/,
  );
  const writer = read('scripts/write-deployment-contract.mjs');
  assert.match(writer, /RELEASE_REQUIRE_TRACKED_INPUTS === 'true'/);
  assert.match(writer, /git', \['-C', root, 'ls-files', '-z'\]/);
  assert.match(writer, /refuses an untracked retained input/);
});

test('registry-writing image job is unreachable from pull requests', () => {
  const workflow = read('.github/workflows/ci.yml');
  const job = workflowJob(workflow, 'build-images', 'integration-tests');

  assert.match(job, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /packages: write/);
  assert.match(job, /docker\/login-action@/);
  assert.equal((job.match(/push: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/g) ?? []).length, 8);
});

test('load gate seeds disposable availability fixtures after health without an opt-out', () => {
  const workflow = read('.github/workflows/ci.yml');
  const job = workflowJob(workflow, 'load-test', 'bootstrap-release-registry');
  const healthStep = job.indexOf('- name: Wait for smoke target');
  const seedStep = job.indexOf('- name: Seed mandatory availability-import load fixtures');
  const smokeStep = job.indexOf('- name: Run mandatory load and availability-import smoke');
  const seed = job.slice(seedStep, smokeStep);

  assert.ok(healthStep > -1, 'missing Stage 13 health gate');
  assert.ok(seedStep > healthStep, 'availability fixtures must be seeded only after stack health passes');
  assert.ok(smokeStep > seedStep, 'mandatory load smoke must run after fixture seeding');
  assert.match(seed, /set -euo pipefail/);
  assert.match(seed, /docker compose --env-file \.env\.smoke run --rm/);
  assert.match(seed, /-e DATA_TARGET_ENV=disposable/);
  assert.match(seed, /migrate sh -lc 'test -n "\$MIGRATION_DATABASE_URL" && DATABASE_URL="\$MIGRATION_DATABASE_URL" node scripts\/seed-e2e\.mjs'/);
  assert.doesNotMatch(seed, /\bif:|continue-on-error|\|\| true/);
});

test('load gate runs the mandatory availability smoke with exact bounded CI inputs', () => {
  const workflow = read('.github/workflows/ci.yml');
  const job = workflowJob(workflow, 'load-test', 'bootstrap-release-registry');
  const smokeStep = job.indexOf('- name: Run mandatory load and availability-import smoke');
  const stopStep = job.indexOf('- name: Stop smoke stack');
  const smoke = job.slice(smokeStep, stopStep);

  assert.ok(smokeStep > -1, 'missing mandatory Stage 13 load smoke');
  assert.ok(stopStep > smokeStep, 'missing Stage 13 cleanup after load smoke');
  assert.match(smoke, /ALLOW_LOCAL_LOAD_SMOKE: 'true'/);
  assert.match(smoke, /AVAILABILITY_IMPORT_TENANT_SLUG: e2e-operations/);
  assert.match(smoke, /AVAILABILITY_IMPORT_LOGIN_IDENTIFIER: e2e\.admin/);
  assert.match(smoke, /AVAILABILITY_IMPORT_LOGIN_PIN: '246810'/);
  assert.match(smoke, /AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER: staff-1/);
  assert.match(smoke, /AVAILABILITY_IMPORT_ORIGIN: https:\/\/smoke\.lunchlineup\.test/);
  assert.match(smoke, /AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION: admin-credit-grant/);
  assert.match(smoke, /LOAD_OUTPUT_DIR: \$\{\{ runner\.temp \}\}\/lunchlineup-candidate-load\/\$\{\{ github\.sha \}\}/);
  assert.match(smoke, /EXPECTED_SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(smoke, /bash scripts\/load-test\.sh/);
  assert.doesNotMatch(smoke, /\bif:|continue-on-error|\|\| true|RUN_AVAILABILITY_IMPORT_SMOKE/);
  assert.doesNotMatch(job, /docker run --rm|artilleryio\/artillery|\bnpx\b|npm exec/);
});

test('candidate DAST and load bundles are uploaded, downloaded, and verified before immutable publication', () => {
  const workflow = read('.github/workflows/ci.yml');
  const dast = workflowJob(workflow, 'dast', 'e2e-tests');
  const load = workflowJob(workflow, 'load-test', 'bootstrap-release-registry');
  const validate = workflowJob(workflow, 'validate-release-gates', 'deploy-staging');
  const uploadPin = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
  const downloadPin = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';

  assert.match(workflow, /ZAP_IMAGE: \$\{\{ vars\.ZAP_IMAGE \}\}/);
  assert.match(dast, /bash scripts\/run-dast\.sh "\$SMOKE_TARGET_URL"/);
  assert.doesNotMatch(dast, /zaproxy\/action-baseline/);
  assert.match(dast, new RegExp(uploadPin));
  assert.match(dast, /name: candidate-dast-\$\{\{ github\.sha \}\}/);
  for (const suffix of ['dast-evidence-', 'dast-zap-']) assert.match(dast, new RegExp(suffix));

  assert.match(load, /bash scripts\/load-test\.sh/);
  assert.match(load, new RegExp(uploadPin));
  assert.match(load, /name: candidate-load-\$\{\{ github\.sha \}\}/);
  for (const suffix of ['load-evidence-', 'load-artillery-', 'load-availability-']) assert.match(load, new RegExp(suffix));

  assert.equal((validate.match(new RegExp(downloadPin, 'g')) ?? []).length >= 4, true);
  assert.match(validate, /name: candidate-dast-\$\{\{ github\.sha \}\}/);
  assert.match(validate, /name: candidate-load-\$\{\{ github\.sha \}\}/);
  const verification = validate.indexOf('launch-proof-evidence.mjs verify-bundle dast');
  const publication = validate.indexOf('publish-release-evidence.mjs');
  assert.ok(verification > -1 && publication > verification, 'candidate bundles must verify before publication');
  assert.match(validate, /--dast-dir \.release\/candidate-dast/);
  assert.match(validate, /--load-dir \.release\/candidate-load/);
  assert.match(validate, /--zap-image "\$ZAP_IMAGE"/);
  assert.match(validate, /--artillery-image "\$ARTILLERY_IMAGE"/);
});

test('production deploy publishes a deterministic deployed-input content digest', () => {
  const workflow = read('.github/workflows/ci.yml');
  const deploy = workflowJob(workflow, 'deploy-production', 'production-image-inventory');
  const digestStep = deploy.indexOf('id: deployed_inputs_content_digest');
  const uploadStep = deploy.indexOf('id: upload_deployed_inputs');

  assert.ok(digestStep > -1, 'missing deployed-input content digest step');
  assert.ok(uploadStep > digestStep, 'content digest must be computed before artifact upload');
  assert.match(
    deploy,
    /deployed_inputs_content_sha256: \$\{\{ steps\.deployed_inputs_content_digest\.outputs\.sha256 \}\}/,
  );
  assert.match(
    deploy,
    /deployed_inputs_content_sha256="\$\(node scripts\/deployed-inputs-content-digest\.mjs "\$release_inputs"\)"/,
  );
  assert.doesNotMatch(deploy, /const crypto = require\('node:crypto'\)/);
  assert.match(deploy, /echo "sha256=\$deployed_inputs_content_sha256" >> "\$GITHUB_OUTPUT"/);
});

test('same-gate production smoke exact-compares content before using deployed inputs', () => {
  const workflow = read('.github/workflows/ci.yml');
  const deploy = workflowJob(workflow, 'deploy-production', 'production-image-inventory');
  const smoke = deploy.slice(
    deploy.indexOf('name: Verify exact deployed release inputs for same-gate smoke'),
    deploy.indexOf('name: Determine same-gate release outcome'),
  );
  const compare = smoke.indexOf(
    'test "$actual_deployed_inputs_content_sha256" = "$EXPECTED_DEPLOYED_INPUTS_CONTENT_SHA256"',
  );
  const bindingVerification = smoke.indexOf('node scripts/deployed-release-inputs.mjs verify');

  assert.match(
    smoke,
    /EXPECTED_DEPLOYED_INPUTS_CONTENT_SHA256: \$\{\{ steps\.deployed_inputs_content_digest\.outputs\.sha256 \}\}/,
  );
  assert.match(smoke, /test -n "\$EXPECTED_ARTIFACT_DIGEST"/);
  assert.ok(compare > -1, 'missing exact deployed-input content digest comparison');
  assert.ok(bindingVerification > compare, 'downloaded files must be content-checked before binding verification');
  assert.match(
    smoke,
    /actual_deployed_inputs_content_sha256="\$\(node scripts\/deployed-inputs-content-digest\.mjs "\$release_inputs"\)"/,
  );
  assert.doesNotMatch(smoke, /const crypto = require\('node:crypto'\)/);
  assert.equal(
    (workflow.match(/node scripts\/deployed-inputs-content-digest\.mjs "\$release_inputs"/g) ?? []).length,
    2,
  );
});

test('deployed-input content digest is stable across roots and creation order', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-deployed-input-digest-'));
  const first = join(temporaryRoot, 'first');
  const second = join(temporaryRoot, 'second');
  try {
    mkdirSync(join(first, 'nested'), { recursive: true });
    writeFileSync(join(first, 'z.json'), '{"z":1}\n');
    writeFileSync(join(first, 'nested', 'a.json'), '{"a":2}\n');
    mkdirSync(join(second, 'nested'), { recursive: true });
    writeFileSync(join(second, 'nested', 'a.json'), '{"a":2}\n');
    writeFileSync(join(second, 'z.json'), '{"z":1}\n');

    const firstDigest = computeDeployedInputsContentDigest(first);
    const secondDigest = computeDeployedInputsContentDigest(second);
    assert.match(firstDigest, /^[a-f0-9]{64}$/);
    assert.equal(firstDigest, secondDigest);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('deployed-input content digest detects file-byte and relative-path tampering', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-deployed-input-tamper-'));
  try {
    writeFileSync(join(temporaryRoot, 'binding.json'), '{"value":1}\n');
    const original = computeDeployedInputsContentDigest(temporaryRoot);

    writeFileSync(join(temporaryRoot, 'binding.json'), '{"value":2}\n');
    assert.notEqual(computeDeployedInputsContentDigest(temporaryRoot), original);

    rmSync(join(temporaryRoot, 'binding.json'));
    writeFileSync(join(temporaryRoot, 'renamed-binding.json'), '{"value":1}\n');
    assert.notEqual(computeDeployedInputsContentDigest(temporaryRoot), original);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
