import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

function findBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    return existsSync(gitBash) ? gitBash : undefined;
  }
  return commandWorks('bash', ['--version']) ? 'bash' : undefined;
}

const lifecycle = read('scripts/internal-beta-lifecycle.sh');
const backupRestore = read('scripts/internal-beta-backup-restore-proof.sh');
const bootstrap = read('scripts/bootstrap-vm107-dev.sh');

test('VM107 beta shell owners are syntactically valid', { skip: !findBash() }, () => {
  const bash = findBash();
  for (const script of [
    'scripts/bootstrap-vm107-dev.sh',
    'scripts/internal-beta-lifecycle.sh',
    'scripts/internal-beta-backup-restore-proof.sh',
  ]) {
    const result = spawnSync(bash, ['-n', join(root, script)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('browser-visible VM107 bootstrap checks out one pushed candidate without rewriting dirty state', () => {
  assert.match(bootstrap, /CANDIDATE_SHA="\$\{CANDIDATE_SHA:-\}"/);
  assert.match(bootstrap, /PUBLIC_APP_ORIGIN.*https:\/\/beta\.lunchlineup\.com[\s\S]*CANDIDATE_SHA is required/);
  assert.match(bootstrap, /git status --porcelain --untracked-files=all/);
  assert.match(bootstrap, /remote_sha="\$\(git rev-parse "\$\{remote_ref\}\^\{commit\}"\)"/);
  assert.match(bootstrap, /"\$remote_sha" == "\$CANDIDATE_SHA"/);
  assert.match(bootstrap, /git checkout --detach "\$CANDIDATE_SHA"/);
  assert.doesNotMatch(bootstrap, /git reset --hard|git clean -[a-z]*f/i);
});

test('internal beta launch is bound to VM107, a clean pushed SHA, and candidate runtime identity', () => {
  assert.match(lifecycle, /BETA_EXPECTED_HOSTNAME:-lunchlineup-dev/);
  assert.match(lifecycle, /APP_DIR must remain \/opt\/lunchlineup on VM107/);
  assert.match(lifecycle, /directly under \/var\/lib\/lunchlineup\/proofs/);
  assert.match(lifecycle, /BETA_PUBLIC_ORIGIN:-https:\/\/beta\.lunchlineup\.com/);
  assert.match(lifecycle, /BETA_CANDIDATE_SHA must be one lowercase 40-character Git SHA/);
  assert.match(lifecycle, /git -C "\$APP_DIR" status --porcelain --untracked-files=all/);
  assert.match(lifecycle, /git -C "\$APP_DIR" fetch --prune origin/);
  assert.match(lifecycle, /"\$remote_sha" == "\$SOURCE_SHA"/);
  for (const key of ['IMAGE_TAG', 'DEPLOY_RELEASE_SHA', 'MIGRATION_SOURCE_SHA']) {
    assert.equal(lifecycle.includes('"$(env_value ' + key + ')" == "$SOURCE_SHA"'), true);
  }
  assert.match(lifecycle, /DATA_TARGET_ENV\)" == disposable/);
  assert.match(lifecycle, /runtime env must not be group- or world-readable/);
  assert.match(lifecycle, /verify-resend-readiness\.mjs/);
  assert.match(lifecycle, /compose run --rm --no-deps --pull never/);
  assert.match(lifecycle, /"providerAccepted": true/);
  const buildCall = lifecycle.lastIndexOf('\n  build_candidate_images\n');
  const providerCall = lifecycle.lastIndexOf('\nverify_resend_provider\n');
  const launchBranch = lifecycle.lastIndexOf('\nif [[ "$ACTION" == launch ]]; then');
  assert.notEqual(buildCall, -1);
  assert.notEqual(providerCall, -1);
  assert.notEqual(launchBranch, -1);
  assert.ok(buildCall < providerCall);
  assert.ok(providerCall < launchBranch);
});

test('launch waits for migrations, beta services, candidate images, and direct/public release identity', () => {
  for (const service of [
    'proxy', 'web', 'api', 'webhook-replay', 'engine', 'pdf-parser', 'worker', 'pitr-wal-provider',
    'api-v2', 'postgres', 'redis', 'rabbitmq', 'control', 'prometheus',
    'alertmanager', 'node-exporter', 'loki', 'promtail', 'otel-collector',
    'tempo', 'grafana', 'autoheal',
  ]) {
    assert.match(lifecycle, new RegExp('\\b' + service + '\\b'));
  }
  assert.match(lifecycle, /compose --profile ops up -d --no-build --pull never --remove-orphans/);
  assert.match(lifecycle, /compose ps -a -q migrate/);
  assert.match(lifecycle, /migration image is not candidate-bound/);
  assert.match(lifecycle, /direct_health http:\/\/127\.0\.0\.1\/health/);
  assert.match(lifecycle, /public_health "\$PUBLIC_ORIGIN\/health"/);
  assert.match(lifecycle, /public_web "\$PUBLIC_ORIGIN\/"/);
  assert.match(lifecycle, /tolower\(\$0\) ~ \/\^x-lunchlineup-release:\//);
  assert.match(lifecycle, /grep -Fq '<h1'/);
  assert.match(lifecycle, /grep -Fq 'LunchLineup'/);
  assert.match(lifecycle, /\/_next\/static\//);
});

test('readiness fails closed on placeholder delivery, alert routing, outbox debt, and critical alerts', () => {
  assert.match(lifecycle, /re_dev_/);
  assert.match(lifecycle, /resendProviderAccepted/);
  assert.match(lifecycle, /STAFF_INVITATION_OUTBOX_ENABLED/);
  assert.match(lifecycle, /PASSWORD_RESET_EMAIL_OUTBOX_ENABLED/);
  assert.match(lifecycle, /SCHEDULE_PUBLISHED_EMAIL_ENABLED/);
  assert.match(lifecycle, /Alertmanager route is still a local or placeholder sink/);
  assert.match(lifecycle, /lunchlineup_password_reset_email_sweep_ready/);
  assert.match(lifecycle, /lunchlineup_staff_invitation_sweep_ready/);
  assert.match(lifecycle, /lunchlineup_notification_outbox_dead_lettered/);
  assert.match(lifecycle, /SolverQueuePoisoned/);
  assert.match(lifecycle, /empty_prometheus_result/);
  assert.match(lifecycle, /internal_beta_readiness_failed/);
});

test('beta backup proof restores only into a temporary database and proves cleanup', () => {
  assert.match(backupRestore, /pg_dump[\s\S]*--format=custom/);
  assert.match(backupRestore, /gpg[\s\S]*--cipher-algo AES256 --symmetric/);
  assert.match(backupRestore, /gpg[\s\S]*--decrypt --passphrase-file/);
  assert.match(backupRestore, /createdb --username "\$postgres_user" --template template0 "\$restore_database"/);
  assert.match(backupRestore, /pg_restore[\s\S]*--exit-on-error[\s\S]*--dbname "\$restore_database"/);
  assert.match(backupRestore, /cmp --silent "\$source_inventory" "\$restore_inventory"/);
  assert.match(backupRestore, /critical_rows=/);
  assert.match(backupRestore, /dropdb --if-exists --force -U "\$postgres_user" "\$restore_database"/);
  assert.match(backupRestore, /temporaryDatabaseRemoved/);
  assert.match(backupRestore, /encryptedSnapshot/);
  assert.match(backupRestore, /schemaAndMigrationInventoryMatched/);
  assert.match(backupRestore, /criticalDataInventoryMatched/);
  assert.match(backupRestore, /timeout --foreground/);
  assert.doesNotMatch(backupRestore, /dropdb[^\r\n]*"\$postgres_database"/);
  assert.doesNotMatch(backupRestore, /docker compose down|down -v|volume rm/);
});

test('pause stops only the VM107 Compose project while preserving data and host boot policy', () => {
  assert.match(lifecycle, /label=com\.docker\.compose\.project=\$COMPOSE_PROJECT_NAME/);
  assert.match(lifecycle, /docker stop --time "\$STOP_TIMEOUT_SECONDS"/);
  assert.match(lifecycle, /internal_beta_paused_ok/);
  assert.match(lifecycle, /data_preserved=true vm_onboot_unchanged=true/);
  assert.doesNotMatch(lifecycle, /docker compose down|down -v|docker volume rm/);
  assert.doesNotMatch(lifecycle, /qm (?:set|start|stop)|systemctl enable/);
});

test('internal beta operation files are indexed beside their operator contract', () => {
  const scriptsReadme = read('scripts/README.md');
  const deployTestsReadme = read('tests/deploy/README.md');
  const runbooksReadme = read('docs/runbooks/README.md');
  const docsReadme = read('docs/README.md');
  const rootReadme = read('README.md');
  const runbook = read('docs/runbooks/internal-beta-operations.md');

  assert.match(scriptsReadme, /internal-beta-backup-restore-proof\.sh/);
  assert.match(scriptsReadme, /internal-beta-lifecycle\.sh/);
  assert.match(deployTestsReadme, /internal-beta-lifecycle\.test\.mjs/);
  assert.match(runbooksReadme, /internal-beta-operations\.md/);
  assert.match(docsReadme, /internal-beta-operations\.md/);
  assert.match(rootReadme, /internal-beta-operations\.md/);
  assert.match(runbook, /onboot: 0/);
  assert.match(runbook, /CANDIDATE_SHA/);
  assert.match(runbook, /internal_beta_readiness_ok/);
  assert.match(runbook, /internal_beta_paused_ok/);
  assert.match(runbook, /does not prove final inbox placement/);
  assert.match(runbook, /bounded test alert/);
  assert.match(runbook, /VM106/);
});
