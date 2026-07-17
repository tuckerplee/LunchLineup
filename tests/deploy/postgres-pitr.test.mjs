import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

function commandWorks(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0;
}

const cgroupOwnerAvailable = process.platform !== 'win32' && commandWorks(bash, ['-c', `
set -eu
path="$(sed -n 's/^0:://p' /proc/self/cgroup)"
parent="/sys/fs/cgroup$path"
domain="$(mktemp -d "$parent/lunchlineup-pitr-test-owner.XXXXXX" 2>/dev/null)"
trap 'rmdir "$domain" 2>/dev/null || true' EXIT
test -w "$domain/cgroup.procs"
test -w "$domain/cgroup.kill"
grep -q '^populated 0$' "$domain/cgroup.events"
`]);
const cgroupOwnerSkip = cgroupOwnerAvailable
  ? false
  : 'a writable delegated cgroup v2 is required for PITR provider tests';
const processTreeSkip = cgroupOwnerAvailable && commandWorks('setsid', ['--help'])
  ? false
  : cgroupOwnerSkip || 'setsid is required for PITR descendant-escape coverage';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function serviceBlock(compose, serviceName) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `missing Compose service: ${serviceName}`);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

test('Compose wires remote-confirmed WAL archiving and isolated PITR services', () => {
  const compose = read('docker-compose.yml');
  const backupDockerfile = read('infrastructure/docker/Dockerfile.backup');
  const postgres = serviceBlock(compose, 'postgres');
  const walProvider = serviceBlock(compose, 'pitr-wal-provider');
  const lifecycleAudit = serviceBlock(compose, 'pitr-lifecycle-audit');
  const baseBackup = serviceBlock(compose, 'pitr-base-backup');
  const restore = serviceBlock(compose, 'pitr-restore');
  const migrate = serviceBlock(compose, 'migrate');
  const deploy = read('scripts/deploy-vm217-remote.sh');

  assert.match(backupDockerfile, /FROM minio\/mc:RELEASE\.2025-08-13T08-35-41Z@sha256:[a-f0-9]{64} AS pitr-client/);
  assert.match(backupDockerfile, /apk add --no-cache .*nodejs coreutils/);
  assert.match(backupDockerfile, /COPY --from=pitr-client \/usr\/bin\/mc \/opt\/lunchlineup\/tools\/mc/);
  assert.match(backupDockerfile, /COPY infrastructure\/postgres\/pitr-verify-object-store\.sh/);
  assert.match(backupDockerfile, /COPY infrastructure\/postgres\/pitr-export-lifecycle-policy\.sh/);
  assert.match(postgres, /infrastructure\/postgres:\/opt\/lunchlineup\/pitr:ro/);
  assert.match(postgres, /PITR_ENABLED=\$\{PITR_ENABLED:-false\}/);
  assert.match(postgres, /archive_mode=\$\{PITR_ARCHIVE_MODE:-off\}/);
  assert.match(postgres, /PITR_WAL_PROVIDER_URL=http:\/\/pitr-wal-provider:8080/);
  assert.match(postgres, /PITR_WAL_PROVIDER_CLIENT_TIMEOUT_SECONDS=930/);
  assert.match(postgres, /pitr-wal-control/);
  assert.doesNotMatch(postgres, /pitr_tools|pitr-wal-object-store|PITR_(?:ACCESS|SECRET)_KEY_FILE|pitr-egress/);
  assert.match(walProvider, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/backup:\$\{IMAGE_TAG:-local\}"/);
  assert.match(walProvider, /init: true/);
  assert.match(walProvider, /user: "70:70"/);
  assert.match(walProvider, /entrypoint: \[ "node", "\/app\/pitr-wal-provider\.mjs" \]/);
  assert.match(walProvider, /PITR_PROVIDER_OWNERSHIP_MODE=container-job/);
  assert.match(walProvider, /PITR_WAL_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-wal-object-store:ro/);
  assert.match(walProvider, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-wal-object-store\/access_key/);
  assert.match(walProvider, /pitr-wal-control/);
  assert.match(walProvider, /pitr-egress/);
  assert.match(lifecycleAudit, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/backup:\$\{IMAGE_TAG:-local\}"/);
  assert.match(lifecycleAudit, /user: "70:70"/);
  assert.match(lifecycleAudit, /PITR_PROVIDER_OWNERSHIP_MODE=container-job/);
  assert.match(lifecycleAudit, /PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-lifecycle-audit-object-store:ro/);
  assert.match(lifecycleAudit, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-lifecycle-audit-object-store\/access_key/);
  assert.match(lifecycleAudit, /pitr-egress/);
  assert.match(baseBackup, /PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-base-backup-object-store:ro/);
  assert.match(baseBackup, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-base-backup-object-store\/access_key/);
  assert.match(baseBackup, /PITR_PROVIDER_OWNERSHIP_MODE=container-job/);
  assert.match(baseBackup, /init: true/);
  assert.match(baseBackup, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/backup:\$\{IMAGE_TAG:-local\}"/);
  assert.match(baseBackup, /PITR_MC_BIN=\/opt\/lunchlineup\/tools\/mc/);
  assert.match(restore, /PITR_RESTORE_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-restore-object-store:ro/);
  assert.match(restore, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-restore-object-store\/access_key/);
  assert.match(restore, /PITR_PROVIDER_OWNERSHIP_MODE=container-job/);
  assert.match(restore, /init: true/);
  assert.match(restore, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/backup:\$\{IMAGE_TAG:-local\}"/);
  assert.match(restore, /PITR_MC_BIN=\/opt\/lunchlineup\/tools\/mc/);
  assert.doesNotMatch(postgres, /pitr-base-backup-object-store|pitr-restore-object-store/);
  assert.doesNotMatch(baseBackup, /pitr-wal-object-store|pitr-restore-object-store/);
  assert.doesNotMatch(restore, /pitr-wal-object-store|pitr-base-backup-object-store/);
  assert.doesNotMatch(migrate, /PITR_|pitr-.*object-store|lifecycle/);
  for (const service of [postgres, walProvider, baseBackup, restore, migrate]) {
    assert.doesNotMatch(service, /PITR_LIFECYCLE.*SECRETS|pitr-lifecycle-audit-object-store/);
  }
  assert.match(lifecycleAudit, /PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR/);
  assert.match(postgres, /PITR_WAL_METRICS_FILE=\/metrics\/lunchlineup_pitr_wal\.prom/);
  assert.match(postgres, /NODE_EXPORTER_TEXTFILE_DIR:-\/var\/lib\/node_exporter\/textfile_collector\}:\/metrics/);
  assert.match(postgres, /pitr-wal-provider:\s*\n\s*condition: service_started/);
  assert.match(baseBackup, /pitr-base-backup\.sh/);
  assert.match(baseBackup, /PITR_OBJECT_LOCK_RETENTION_DAYS/);
  assert.match(baseBackup, /lunchlineup_pitr\.prom/);
  assert.match(restore, /profiles:\s*\n\s*- recovery/);
  assert.match(restore, /PITR_ARCHIVED_WAL_SEGMENT=\$\{PITR_ARCHIVED_WAL_SEGMENT:-\}/);
  assert.match(restore, /PITR_BASE_BACKUP_COMPLETE_VERSION_ID=\$\{PITR_BASE_BACKUP_COMPLETE_VERSION_ID:-\}/);
  assert.match(restore, /PITR_BASE_BACKUP_ARCHIVE_VERSION_ID=\$\{PITR_BASE_BACKUP_ARCHIVE_VERSION_ID:-\}/);
  assert.match(restore, /PITR_BASE_BACKUP_MANIFEST_VERSION_ID=\$\{PITR_BASE_BACKUP_MANIFEST_VERSION_ID:-\}/);
  assert.match(restore, /PITR_ARCHIVED_WAL_VERSION_ID=\$\{PITR_ARCHIVED_WAL_VERSION_ID:-\}/);
  assert.match(restore, /postgres_pitr_restore_data:\/restore/);
  assert.doesNotMatch(restore, /postgres_data:\/restore/);
  assert.match(compose, /^  pitr-egress:\s*$/m);
  assert.match(compose, /^  pitr-wal-control:\s*$/m);
  assert.doesNotMatch(compose, /^  pitr_tools:\s*$/m);
  assert.match(compose, /^  pitr_staging:\s*$/m);
  assert.match(compose, /^  postgres_pitr_restore_data:\s*$/m);
  const storagePreflight = deploy.indexOf('bash scripts/pitr-verify-storage.sh');
  const stackMutation = deploy.indexOf('compose_release up -d --no-build --pull never');
  assert.ok(storagePreflight > 0 && storagePreflight < stackMutation);
});

test('rendered Compose defaults non-PITR Postgres to archive off and forwards exact restore versions', (t) => {
  const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 5_000 });
  if (available.status !== 0) {
    t.skip('docker compose is not available');
    return;
  }
  const compose = read('docker-compose.yml');
  const env = { ...process.env };
  delete env.PITR_ARCHIVE_MODE;
  for (const match of compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g)) {
    env[match[1]] = env[match[1]] || 'compose-fixture';
  }
  Object.assign(env, {
    PITR_BASE_BACKUP_COMPLETE_VERSION_ID: 'complete-version-exact-101',
    PITR_BASE_BACKUP_ARCHIVE_VERSION_ID: 'archive-version-exact-202',
    PITR_BASE_BACKUP_MANIFEST_VERSION_ID: 'manifest-version-exact-303',
    PITR_ARCHIVED_WAL_VERSION_ID: 'wal-version-exact-404',
  });
  const render = (overrides = {}) => spawnSync(
    'docker',
    ['compose', '--profile', 'recovery', 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...env, ...overrides } },
  );

  const nonPitr = render();
  assert.equal(nonPitr.status, 0, nonPitr.stderr);
  const nonPitrConfig = JSON.parse(nonPitr.stdout);
  assert.deepEqual(nonPitrConfig.services.postgres.command.slice(-2), ['-c', 'archive_mode=off']);
  assert.deepEqual(
    {
      complete: nonPitrConfig.services['pitr-restore'].environment.PITR_BASE_BACKUP_COMPLETE_VERSION_ID,
      archive: nonPitrConfig.services['pitr-restore'].environment.PITR_BASE_BACKUP_ARCHIVE_VERSION_ID,
      manifest: nonPitrConfig.services['pitr-restore'].environment.PITR_BASE_BACKUP_MANIFEST_VERSION_ID,
      wal: nonPitrConfig.services['pitr-restore'].environment.PITR_ARCHIVED_WAL_VERSION_ID,
    },
    {
      complete: 'complete-version-exact-101',
      archive: 'archive-version-exact-202',
      manifest: 'manifest-version-exact-303',
      wal: 'wal-version-exact-404',
    },
  );

  const pitr = render({ PITR_ARCHIVE_MODE: 'on', PITR_ENABLED: 'true' });
  assert.equal(pitr.status, 0, pitr.stderr);
  assert.deepEqual(JSON.parse(pitr.stdout).services.postgres.command.slice(-2), ['-c', 'archive_mode=on']);
});

test('Postgres only acknowledges production WAL after encrypted remote durability proof', () => {
  const config = read('infrastructure/postgres/postgresql.conf');
  const archive = read('infrastructure/postgres/archive-wal.sh');
  const common = read('infrastructure/postgres/pitr-object-store.sh');
  const providerUpload = read('infrastructure/postgres/pitr-wal-provider-upload.sh');
  const providerServer = read('scripts/pitr-wal-provider.mjs');

  assert.match(config, /^wal_level = replica$/m);
  assert.match(config, /^archive_mode = off$/m);
  assert.match(config, /archive_command = 'sh \/opt\/lunchlineup\/pitr\/archive-wal\.sh/);
  assert.match(config, /^archive_timeout = 60s$/m);
  assert.match(archive, /--post-file="\$\{SOURCE_PATH\}"/);
  assert.match(archive, /PITR_WAL_PROVIDER_URL.*http:\/\/pitr-wal-provider:8080/);
  assert.match(archive, /pitr_wal_provider_uploaded/);
  assert.match(archive, /ARCHIVE_VERSION="\$\{provider_version#version_id=\}"/);
  assert.match(archive, /conditional_create=true/);
  assert.doesNotMatch(archive, /pitr_upload_encrypted|PITR_ACCESS_KEY_FILE|PITR_SECRET_KEY_FILE/);
  assert.match(archive, /cannot acknowledge WAL unless PITR_ENABLED=true/);
  assert.match(providerUpload, /ARCHIVE_VERSION="\$\(pitr_upload_encrypted/);
  assert.match(providerUpload, /pitr_wal_provider_uploaded/);
  assert.match(providerServer, /PITR_WAL_PROVIDER_MAX_BYTES/);
  assert.match(providerServer, /PITR_WAL_PROVIDER_REQUEST_TIMEOUT_MS/);
  assert.match(providerServer, /PITR_PROVIDER_OWNERSHIP_MODE: 'container-job'/);
  assert.match(providerServer, /exitAfterResponse\(response, 70\)/);
  assert.match(providerServer, /content-length/);
  assert.match(common, /pitr_remote_stat_json/);
  assert.match(common, /stat state is unknown/);
  assert.match(common, /--custom-header 'If-None-Match:\*'/);
  assert.match(common, /pitr_resolve_single_version/);
  assert.match(common, /pitr_download_version/);
  assert.match(common, /cmp -s/);
  assert.match(common, /Remote PITR object conflicts/);
  assert.match(common, /--checksum SHA256/);
  assert.match(common, /--disable-multipart/);
  assert.match(common, /--enc-s3/);
  assert.match(common, /--retention-mode COMPLIANCE/);
  assert.match(common, /--retention-duration "\$\{PITR_OBJECT_LOCK_RETENTION_DAYS\}d"/);
  assert.match(common, /PITR_S3_ENDPOINT must use HTTPS/);
  assert.match(common, /PITR_MC_TIMEOUT_SECONDS/);
  assert.match(common, /PITR_MC_KILL_AFTER_SECONDS/);
  assert.match(common, /PITR_PROVIDER_OWNERSHIP_MODE/);
  assert.match(common, /pitr_owner_process_snapshot/);
  assert.match(common, /pitr_owner_container_job_survivors/);
  assert.match(common, /aborting the request-scoped container ownership domain/);
  assert.match(common, /pitr_upload_source_dir="\$\(dirname "\$\{source_file\}"\)"/);
  assert.match(common, /mktemp "\$\{pitr_upload_source_dir\}\/\.lunchlineup-pitr-upload-verify\.XXXXXX"/);
  assert.match(common, /lunchlineup-pitr-provider\.XXXXXX/);
  assert.match(common, /cgroup\.kill/);
  assert.match(common, /cgroup\.events/);
  assert.match(common, /kill -STOP/);
  assert.match(common, /ownership domain could not be proven empty/);
  assert.match(common, /timeout \\\n\s*--signal=TERM \\\n\s*--kill-after=/);
  assert.doesNotMatch(common, /--foreground/);
  assert.match(common, /PITR_MC_CONFIG_FILE="\$\{PITR_MC_CONFIG_DIR\}\/config\.json"/);
  assert.match(common, /chmod 0600 "\$\{PITR_MC_CONFIG_FILE\}"/);
  assert.doesNotMatch(common, /alias set/);
  assert.equal((common.match(/"\$\{PITR_MC_BIN\}" --config-dir/g) ?? []).length, 2, 'only bounded pitr_mc ownership modes may execute mc');
});

test('a setsid PITR provider descendant receives protected config and cannot mutate output after return', { skip: processTreeSkip }, (t) => {
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  const timeoutAvailable = spawnSync(bash, ['-lc', 'command -v timeout >/dev/null'], { encoding: 'utf8' });
  if (version.status !== 0 || timeoutAvailable.status !== 0) {
    t.skip('bash with GNU timeout is not available');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-hanging-mc-'));
  const accessKey = join(scratch, 'access-key');
  const secretKey = join(scratch, 'secret-key');
  const fakeMc = join(scratch, 'fake-mc');
  const argvFile = join(scratch, 'mc-argv.txt');
  const configCopy = join(scratch, 'mc-config.json');
  const configMode = join(scratch, 'mc-config-mode.txt');
  const parentPidFile = join(scratch, 'mc-parent.pid');
  const childPidFile = join(scratch, 'mc-child.pid');
  const delayedOutput = join(scratch, 'delayed-download');
  const exporter = join(root, 'infrastructure/postgres/pitr-export-lifecycle-policy.sh');
  const accessSecret = 'PITR-ACCESS-SECRET-ONLY-IN-CONFIG';
  const keySecret = 'PITR-KEY-SECRET-ONLY-IN-CONFIG';
  const baseEnv = {
    ...process.env,
    PITR_ENABLED: 'true',
    PITR_S3_ENDPOINT: 'https://object-store.example',
    PITR_S3_BUCKET: 'lunchlineup-pitr',
    PITR_S3_PREFIX: 'production/cluster-a',
    PITR_OBJECT_LOCK_RETENTION_DAYS: '14',
    PITR_ACCESS_KEY_FILE: bashPath(accessKey),
    PITR_SECRET_KEY_FILE: bashPath(secretKey),
    PITR_MC_BIN: bashPath(fakeMc),
    PITR_MC_TIMEOUT_SECONDS: '1',
    PITR_MC_KILL_AFTER_SECONDS: '1',
  };
  try {
    writeFileSync(accessKey, `${accessSecret}\n`);
    writeFileSync(secretKey, `${keySecret}\n`);
    writeFileSync(fakeMc, `#!/bin/sh
set -eu
: >'${bashPath(argvFile)}'
config_dir=''
while [ "$#" -gt 0 ]; do
  printf '%s\n' "$1" >>'${bashPath(argvFile)}'
  if [ "$1" = --config-dir ]; then shift; config_dir="$1"; printf '%s\n' "$1" >>'${bashPath(argvFile)}'; fi
  shift
done
cp "$config_dir/config.json" '${bashPath(configCopy)}'
stat -c '%a' "$config_dir/config.json" >'${bashPath(configMode)}'
setsid sh -c '
  trap "" TERM
  printf "%s\\n" "$$" > "${bashPath(childPidFile)}"
  sleep 3
  printf "delayed PITR download\\n" > "${bashPath(delayedOutput)}"
  while :; do sleep 1; done
' &
child=$!
printf '%s\n' "$$" >'${bashPath(parentPidFile)}'
trap "" TERM
wait "$child"
`);
    chmodSync(fakeMc, 0o700);
    const started = Date.now();
    const result = spawnSync(bash, [exporter], {
      cwd: root,
      encoding: 'utf8',
      env: baseEnv,
      timeout: 8_000,
      killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - started;
    assert.notEqual(result.status, 0);
    assert.equal(result.error?.code, undefined, 'blocked provider exceeded the outer test deadline');
    assert.ok(elapsed < 7_000, `blocked provider was not kill-bounded (${elapsed}ms)`);
    assert.match(`${result.stdout}\n${result.stderr}`, /timed out after 1s; its cgroup v2 ownership domain was TERM-then-KILL bounded after 1s and proven empty/);

    const argv = readFileSync(argvFile, 'utf8');
    assert.match(argv, /^--config-dir$/m);
    assert.doesNotMatch(argv, new RegExp(`${accessSecret}|${keySecret}`));
    const protectedConfig = readFileSync(configCopy, 'utf8');
    assert.match(protectedConfig, new RegExp(accessSecret));
    assert.match(protectedConfig, new RegExp(keySecret));
    assert.equal(readFileSync(configMode, 'utf8').trim(), '600');
    const parentPid = readFileSync(parentPidFile, 'utf8').trim();
    const childPid = readFileSync(childPidFile, 'utf8').trim();
    const processCheck = spawnSync(bash, [
      '-c', 'for pid in "$@"; do ! kill -0 "$pid" 2>/dev/null || exit 1; done',
      'pitr-process-check', parentPid, childPid,
    ], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
    assert.equal(processCheck.status, 0, `PITR provider process survived: parent=${parentPid} child=${childPid}`);
    rmSync(delayedOutput, { force: true });
    const delayedRewriteWindow = spawnSync(bash, ['-c', 'sleep 2'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
    });
    assert.equal(delayedRewriteWindow.status, 0);
    assert.equal(existsSync(delayedOutput), false, 'setsid PITR descendant mutated output after pitr_mc returned');

    const invalid = spawnSync(bash, [exporter], {
      cwd: root,
      encoding: 'utf8',
      env: { ...baseEnv, PITR_MC_TIMEOUT_SECONDS: '0' },
      timeout: 3_000,
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /PITR_MC_TIMEOUT_SECONDS must be an integer from 1 through 3600/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('fake provider restore consumes all four exact immutable provider versions', { skip: cgroupOwnerSkip }, (t) => {
  const commands = spawnSync(bash, ['-lc', 'command -v timeout tar sha256sum >/dev/null'], { encoding: 'utf8' });
  if (commands.status !== 0) {
    t.skip('bash restore prerequisites are unavailable');
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-restore-provider-'));
  const objects = join(scratch, 'objects');
  const baseData = join(scratch, 'base-data');
  const restoreData = join(scratch, 'restore-data');
  const staging = join(scratch, 'staging');
  const fakeBin = join(scratch, 'bin');
  const accessKey = join(scratch, 'access-key');
  const secretKey = join(scratch, 'secret-key');
  const fakeMc = join(fakeBin, 'mc');
  const providerLog = join(scratch, 'provider.log');
  const backupId = '20260716T120000Z-4242';
  const walSegment = '000000010000000000000042';
  const versions = {
    COMPLETE: 'complete-version-exact-101',
    'base.tar.gz': 'archive-version-exact-202',
    backup_manifest: 'manifest-version-exact-303',
    [walSegment]: 'wal-version-exact-404',
  };
  try {
    for (const directory of [objects, baseData, restoreData, staging, fakeBin]) mkdirSync(directory);
    const manifest = Buffer.from('fake pg_basebackup manifest\n');
    writeFileSync(join(baseData, 'backup_manifest'), manifest);
    writeFileSync(join(baseData, 'PG_VERSION'), '16\n');
    const archivePath = join(objects, 'base.tar.gz');
    const archived = spawnSync(bash, ['-lc', 'tar -czf "$1" -C "$2" .', 'fixture', bashPath(archivePath), bashPath(baseData)], { encoding: 'utf8' });
    assert.equal(archived.status, 0, archived.stderr);
    writeFileSync(join(objects, 'backup_manifest'), manifest);
    writeFileSync(join(objects, 'COMPLETE'), [
      `backup_id=${backupId}`,
      'completed_at=2026-07-16T12:00:00Z',
      `manifest_sha256=${createHash('sha256').update(manifest).digest('hex')}`,
      '',
    ].join('\n'));
    writeFileSync(join(objects, walSegment), 'wal-bytes');
    writeFileSync(accessKey, 'restore-access\n');
    writeFileSync(secretKey, 'restore-secret\n');
    writeFileSync(join(fakeBin, 'pg_verifybackup'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeBin, 'pg_verifybackup'), 0o700);
    writeFileSync(fakeMc, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>'${bashPath(providerLog)}'
[ "$1" = --config-dir ] || exit 91
shift 2
case "$1 $2" in
  'cp --version-id') object_name="$4" ;;
  *) for object_name do :; done ;;
esac
case "$object_name" in
  */COMPLETE) local_file='${bashPath(join(objects, 'COMPLETE'))}'; expected='${versions.COMPLETE}' ;;
  */base.tar.gz) local_file='${bashPath(join(objects, 'base.tar.gz'))}'; expected='${versions['base.tar.gz']}' ;;
  */backup_manifest) local_file='${bashPath(join(objects, 'backup_manifest'))}'; expected='${versions.backup_manifest}' ;;
  */${walSegment}) local_file='${bashPath(join(objects, walSegment))}'; expected='${versions[walSegment]}' ;;
  *) exit 92 ;;
esac
case "$1 $2" in
  '--json ls') printf '{"versionId":"%s"}\\n' "$expected" ;;
  '--json stat')
    [ "$3" = --version-id ] && [ "$4" = "$expected" ] || exit 93
    printf '{"versionId":"%s"}\\n' "$expected"
    ;;
  'cp --version-id')
    [ "$3" = "$expected" ] || exit 94
    cp "$local_file" "$5"
    ;;
  *) exit 95 ;;
esac
`);
    chmodSync(fakeMc, 0o700);

    const result = spawnSync(bash, [join(root, 'scripts/pitr-restore.sh')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bashPath(fakeBin)}:${process.env.PATH}`,
        PITR_ENABLED: 'true',
        PITR_S3_ENDPOINT: 'https://object-store.example',
        PITR_S3_BUCKET: 'lunchlineup-pitr',
        PITR_S3_PREFIX: 'production/cluster-a',
        PITR_OBJECT_LOCK_RETENTION_DAYS: '14',
        PITR_ACCESS_KEY_FILE: bashPath(accessKey),
        PITR_SECRET_KEY_FILE: bashPath(secretKey),
        PITR_MC_BIN: bashPath(fakeMc),
        PITR_BASE_BACKUP_ID: backupId,
        PITR_RECOVERY_TARGET_TIME: '2026-07-16T12:30:00Z',
        PITR_ARCHIVED_WAL_SEGMENT: walSegment,
        PITR_BASE_BACKUP_COMPLETE_VERSION_ID: versions.COMPLETE,
        PITR_BASE_BACKUP_ARCHIVE_VERSION_ID: versions['base.tar.gz'],
        PITR_BASE_BACKUP_MANIFEST_VERSION_ID: versions.backup_manifest,
        PITR_ARCHIVED_WAL_VERSION_ID: versions[walSegment],
        PITR_RESTORE_CONFIRM: `restore-pitr-${backupId}`,
        PITR_RESTORE_DATA_DIR: bashPath(restoreData),
        PITR_STAGING_DIR: bashPath(staging),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /complete_version_id=complete-version-exact-101/);
    assert.match(result.stdout, /archive_version_id=archive-version-exact-202/);
    assert.match(result.stdout, /manifest_version_id=manifest-version-exact-303/);
    assert.match(result.stdout, /wal_version_id=wal-version-exact-404/);
    const source = readFileSync(join(restoreData, 'lunchlineup-pitr-restore-source'), 'utf8');
    for (const exactVersion of Object.values(versions)) assert.match(source, new RegExp(exactVersion));
    const providerCalls = readFileSync(providerLog, 'utf8');
    for (const exactVersion of Object.values(versions)) assert.match(providerCalls, new RegExp(`--version-id ${exactVersion}`));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('authorization simulation proves denied mutations for restore and lifecycle-audit identities', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-authorization-'));
  const verifier = join(root, 'scripts/pitr-verify-authorization-simulation.mjs');
  const denied = [
    's3:PutObject',
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:PutObjectRetention',
    's3:BypassGovernanceRetention',
    's3:PutLifecycleConfiguration',
    's3:PutBucketPolicy',
    's3:DeleteBucket',
  ];
  const roles = {
    restore: ['s3:ListBucket', 's3:GetObject', 's3:GetObjectVersion', 's3:GetObjectRetention'],
    'lifecycle-audit': ['s3:GetLifecycleConfiguration', 's3:GetBucketVersioning', 's3:GetObjectLockConfiguration'],
  };
  try {
    for (const [role, allowed] of Object.entries(roles)) {
      const requestPath = join(scratch, `${role}-request.json`);
      const responsePath = join(scratch, `${role}-response.json`);
      const request = {
        version: 1,
        kind: 'lunchlineup-pitr-provider-authorization-request',
        requestId: `${role}-request-20260716`,
        generatedAt: new Date().toISOString(),
        role,
        scope: {
          endpoint: 'https://s3.us-west-2.amazonaws.com',
          bucket: 'lunchlineup-prod-pitr',
          prefix: 'lunchlineup/production/cluster-01',
        },
        requiredAllowedActions: allowed,
        requiredDeniedActions: denied,
      };
      const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`);
      writeFileSync(requestPath, requestBytes);
      const response = {
        version: 1,
        kind: 'lunchlineup-pitr-provider-authorization-result',
        source: 'provider-authorization-api',
        requestId: request.requestId,
        requestSha256: createHash('sha256').update(requestBytes).digest('hex'),
        role,
        scope: request.scope,
        principal: `arn:aws:iam::123456789012:role/lunchlineup-pitr-${role}`,
        providerRequestId: `${role}-provider-request-12345`,
        simulatedAt: new Date().toISOString(),
        decisions: Object.fromEntries([
          ...allowed.map((action) => [action, 'allowed']),
          ...denied.map((action) => [action, 'denied']),
        ]),
      };
      writeFileSync(responsePath, JSON.stringify(response));
      const accepted = spawnSync(process.execPath, [
        verifier,
        '--request-file', requestPath,
        '--response-file', responsePath,
        '--simulator-sha256', 'a'.repeat(64),
        '--maximum-age-seconds', '120',
      ], { cwd: root, encoding: 'utf8' });
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, new RegExp(`role=${role} .*denied_mutations=${denied.length}`));

      response.decisions['s3:PutObject'] = 'allowed';
      writeFileSync(responsePath, JSON.stringify(response));
      const overprivileged = spawnSync(process.execPath, [
        verifier,
        '--request-file', requestPath,
        '--response-file', responsePath,
        '--simulator-sha256', 'a'.repeat(64),
      ], { cwd: root, encoding: 'utf8' });
      assert.notEqual(overprivileged.status, 0);
      assert.match(overprivileged.stderr, new RegExp(`${role} identity is overprivileged for s3:PutObject`));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('PITR shell scripts parse and an invoked disabled archive fails closed', (t) => {
  const scripts = [
    'infrastructure/postgres/pitr-object-store.sh',
    'infrastructure/postgres/archive-wal.sh',
    'infrastructure/postgres/restore-wal.sh',
    'infrastructure/postgres/pitr-verify-object-store.sh',
    'infrastructure/postgres/pitr-export-lifecycle-policy.sh',
    'scripts/pitr-base-backup.sh',
    'scripts/pitr-run-candidate-job.sh',
    'scripts/pitr-verify-storage.sh',
    'scripts/pitr-restore.sh',
  ];
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('bash is not available');
    return;
  }

  for (const path of scripts) {
    const result = spawnSync(bash, ['-n', join(root, path)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-'));
  try {
    const wal = join(scratch, '000000010000000000000001');
    writeFileSync(wal, 'wal-fixture');
    const disabled = spawnSync(bash, [join(root, 'infrastructure/postgres/archive-wal.sh'), wal, '000000010000000000000001'], {
      encoding: 'utf8',
      env: { ...process.env, PITR_ENABLED: 'false' },
    });
    assert.notEqual(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stderr, /cannot acknowledge WAL unless PITR_ENABLED=true/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('PITR provider state and restore versions fail closed on unknown, conflict, unversioned, and old objects', (t) => {
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('bash is not available');
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-version-state-'));
  const common = bashPath(join(root, 'infrastructure/postgres/pitr-object-store.sh'));
  const runCase = (name, body) => {
    const script = join(scratch, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\nset -eu\n. "${common}"\n${body}\n`);
    return spawnSync(bash, [script], { cwd: root, encoding: 'utf8', timeout: 8_000 });
  };
  try {
    const unknown = runCase('unknown-stat', `
pitr_mc() { echo 'AccessDenied: provider authorization state unknown' >&2; return 1; }
pitr_remote_stat_json 'pitr/bucket/prefix/object' '${bashPath(join(scratch, 'unknown.json'))}'
`);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /stat state is unknown/);

    const conflict = runCase('conflicting-versions', `
pitr_mc() {
  printf '%s\n' '{"versionId":"version-one"}' '{"versionId":"version-two"}'
}
pitr_resolve_single_version 'pitr/bucket/prefix/object'
`);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /missing, conflicting, unversioned, or delete-marker history/);

    const unversioned = runCase('unversioned', `
pitr_mc() { printf '%s\n' '{"versionId":"null"}'; }
pitr_resolve_single_version 'pitr/bucket/prefix/object'
`);
    assert.notEqual(unversioned.status, 0);
    assert.match(unversioned.stderr, /missing, conflicting, unversioned, or delete-marker history/);

    const oldRestore = runCase('old-restore', `
pitr_mc() { printf '%s\n' '{"versionId":"version-current"}'; }
pitr_download_version 'pitr/bucket/prefix/object' 'version-old' '${bashPath(join(scratch, 'old-download'))}'
`);
    assert.notEqual(oldRestore.status, 0);
    assert.match(oldRestore.stderr, /returned a different object version/);

    const callLog = bashPath(join(scratch, 'exact-call.log'));
    const exactRestore = runCase('exact-restore', `
pitr_mc() {
  printf '%s\n' "$*" >>'${callLog}'
  case " $* " in
    *' --json stat --version-id version-exact '*) printf '%s\n' '{"versionId":"version-exact"}' ;;
    *' cp --version-id version-exact '*)
      for argument in "$@"; do destination="$argument"; done
      printf '%s\n' 'exact immutable bytes' >"$destination"
      ;;
    *) return 1 ;;
  esac
}
pitr_download_version 'pitr/bucket/prefix/object' 'version-exact' '${bashPath(join(scratch, 'exact-download'))}'
`);
    assert.equal(exactRestore.status, 0, exactRestore.stderr);
    assert.match(readFileSync(join(scratch, 'exact-call.log'), 'utf8'), /cp --version-id version-exact/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('archive and restore commands accept only exact PostgreSQL archive names', (t) => {
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('bash is not available');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-wal-names-'));
  const source = join(scratch, 'source');
  writeFileSync(source, 'archive-fixture');
  try {
    const valid = [
      '000000010000000000000001',
      '00000002.history',
      '000000010000000000000001.00000020.backup',
    ];
    const invalid = [
      '00000001000000000000001',
      '000000010000000000000001.partial',
      '0000000A0000000000000001.backup',
      '000000010000000000000001.0000002.backup',
      '000000010000000000000001.00000020.backup.extra',
      '0000000a.history',
      '../000000010000000000000001',
    ];

    for (const name of valid) {
      const archived = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/archive-wal.sh'), source, name],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.notEqual(archived.status, 0, `disabled archive must fail closed for ${name}`);
      assert.doesNotMatch(archived.stderr, /Unexpected WAL archive filename/, name);
      assert.match(archived.stderr, /cannot acknowledge WAL unless PITR_ENABLED=true/, name);

      const restored = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/restore-wal.sh'), name, join(scratch, 'restore')],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.doesNotMatch(restored.stderr, /Unexpected WAL restore filename/, name);
    }

    for (const name of invalid) {
      const archived = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/archive-wal.sh'), source, name],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.notEqual(archived.status, 0, `archive should reject ${name}`);
      assert.match(archived.stderr, /Unexpected WAL archive filename/);

      const restored = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/restore-wal.sh'), name, join(scratch, 'restore')],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.notEqual(restored.status, 0, `restore should reject ${name}`);
      assert.match(restored.stderr, /Unexpected WAL restore filename/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('PITR lifecycle verifier binds live policy, immutable minimum, and bounded expiry proof', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-lifecycle-'));
  const verifier = join(root, 'scripts/verify-pitr-lifecycle-policy.mjs');
  const policyPath = join(scratch, 'policy.json');
  const proofPath = join(scratch, 'proof.json');
  const prefix = 'lunchlineup/production/cluster-01/';
  const validPolicy = {
    Rules: [
      {
        Expiration: { Days: 30 },
        Filter: { Prefix: prefix },
        ID: 'pitr-current-expiration',
        Status: 'Enabled',
      },
      {
        Filter: { Prefix: prefix },
        ID: 'pitr-noncurrent-expiration',
        NoncurrentVersionExpiration: { NoncurrentDays: 5 },
        Status: 'Enabled',
      },
      {
        Expiration: { ExpiredObjectDeleteMarker: true },
        Filter: { Prefix: prefix },
        ID: 'pitr-delete-marker-cleanup',
        Status: 'Enabled',
      },
    ],
  };
  const common = [
    verifier,
    '--endpoint', 'https://s3.us-west-2.amazonaws.com',
    '--bucket', 'lunchlineup-prod-pitr',
    '--prefix', 'lunchlineup/production/cluster-01',
    '--immutable-days', '14',
    '--maximum-days', '35',
  ];

  try {
    writeFileSync(policyPath, JSON.stringify(validPolicy), 'utf8');
    const generated = spawnSync(process.execPath, [
      ...common,
      '--policy-file', policyPath,
      '--canonical-output', proofPath,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(
      generated.stdout,
      /pitr_lifecycle_policy_ready .*configured_upper_bound_days=35 .*maximum_retention_days=35/,
    );
    const policySha256 = generated.stdout.match(/policy_sha256=([a-f0-9]{64})/)?.[1];
    assert.ok(policySha256);

    const verified = spawnSync(process.execPath, [
      ...common,
      '--policy-file', policyPath,
      '--proof-file', proofPath,
      '--expected-sha256', policySha256,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);

    const tooEarlyPath = join(scratch, 'too-early.json');
    writeFileSync(
      tooEarlyPath,
      JSON.stringify({
        ...validPolicy,
        Rules: validPolicy.Rules.map((rule) => (
          rule.ID === 'pitr-current-expiration'
            ? { ...rule, Expiration: { Days: 7 } }
            : rule
        )),
      }),
      'utf8',
    );
    const tooEarly = spawnSync(process.execPath, [
      ...common,
      '--policy-file', tooEarlyPath,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(tooEarly.status, 0);
    assert.match(tooEarly.stderr, /expires current objects before the 14-day immutable window/);

    const sizeFilteredPath = join(scratch, 'size-filtered.json');
    writeFileSync(
      sizeFilteredPath,
      JSON.stringify({
        ...validPolicy,
        Rules: validPolicy.Rules.map((rule) => (
          rule.ID === 'pitr-current-expiration'
            ? {
                ...rule,
                Filter: {
                  And: {
                    ObjectSizeGreaterThan: 1024,
                    Prefix: prefix,
                  },
                },
              }
            : rule
        )),
      }),
      'utf8',
    );
    const sizeFiltered = spawnSync(process.execPath, [
      ...common,
      '--policy-file', sizeFilteredPath,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(sizeFiltered.status, 0);
    assert.match(sizeFiltered.stderr, /expire current versions after a bounded number of days/);

    const unboundedPath = join(scratch, 'unbounded.json');
    writeFileSync(
      unboundedPath,
      JSON.stringify({
        ...validPolicy,
        Rules: validPolicy.Rules.map((rule) => (
          rule.ID === 'pitr-noncurrent-expiration'
            ? {
                ...rule,
                NoncurrentVersionExpiration: {
                  NewerNoncurrentVersions: 2,
                  NoncurrentDays: 5,
                },
              }
            : rule
        )),
      }),
      'utf8',
    );
    const unbounded = spawnSync(process.execPath, [
      ...common,
      '--policy-file', unboundedPath,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(unbounded.status, 0);
    assert.match(unbounded.stderr, /expire every noncurrent version/);

    writeFileSync(
      policyPath,
      JSON.stringify({
        ...validPolicy,
        Rules: validPolicy.Rules.map((rule) => (
          rule.ID === 'pitr-noncurrent-expiration'
            ? { ...rule, NoncurrentVersionExpiration: { NoncurrentDays: 4 } }
            : rule
        )),
      }),
      'utf8',
    );
    const drifted = spawnSync(process.execPath, [
      ...common,
      '--policy-file', policyPath,
      '--proof-file', proofPath,
      '--expected-sha256', policySha256,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /Retained lifecycle proof does not match the live bucket policy/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('base backup, retention, restore, timer, and runbook form a machine-checkable PITR chain', () => {
  const base = read('scripts/pitr-base-backup.sh');
  const restore = read('scripts/pitr-restore.sh');
  const timer = read('infrastructure/systemd/lunchlineup-pitr-base-backup.timer');
  const service = read('infrastructure/systemd/lunchlineup-pitr-base-backup.service');
  const runbook = read('docs/runbooks/postgres-pitr-recovery.md');
  const storageVerifier = read('infrastructure/postgres/pitr-verify-object-store.sh');
  const lifecycleExporter = read('infrastructure/postgres/pitr-export-lifecycle-policy.sh');
  const lifecycleVerifier = read('scripts/verify-pitr-lifecycle-policy.mjs');
  const storagePreflight = read('scripts/pitr-verify-storage.sh');

  assert.match(base, /pg_basebackup/);
  assert.match(base, /--format=plain/);
  assert.match(base, /--wal-method=stream/);
  assert.match(base, /--manifest-checksums=SHA256/);
  assert.match(base, /pg_verifybackup --no-parse-wal --exit-on-error "\$\{BACKUP_DATA_DIR\}"/);
  assert.doesNotMatch(base, /pg_verifybackup --format=tar/);
  assert.ok(base.indexOf('pg_verifybackup') < base.indexOf('tar -czf'));
  assert.ok(base.indexOf('COMPLETE is the commit marker') < base.indexOf('pitr_upload_encrypted "${BACKUP_DIR}/COMPLETE"'));
  assert.doesNotMatch(base, /pitr_mc rm|--older-than|PITR_(?:BASE_BACKUP|WAL)_RETENTION_DAYS/);
  assert.match(restore, /PITR_BASE_BACKUP_ID/);
  assert.match(restore, /PITR_RECOVERY_TARGET_TIME/);
  assert.match(restore, /PITR_ARCHIVED_WAL_SEGMENT/);
  assert.match(restore, /PITR_RESTORE_CONFIRM/);
  assert.match(restore, /Remote base backup has no COMPLETE commit marker/);
  assert.match(restore, /COMPLETE marker does not match the named base backup/);
  assert.match(restore, /Named archived WAL segment version is not remotely durable/);
  assert.match(restore, /PITR_BASE_BACKUP_COMPLETE_VERSION_ID/);
  assert.match(restore, /PITR_BASE_BACKUP_ARCHIVE_VERSION_ID/);
  assert.match(restore, /PITR_BASE_BACKUP_MANIFEST_VERSION_ID/);
  assert.match(restore, /PITR_ARCHIVED_WAL_VERSION_ID/);
  assert.match(restore, /pitr_resolve_single_version/);
  assert.match(restore, /pitr_download_version/);
  assert.match(restore, /PITR_RESTORE_DATA_DIR must be empty/);
  assert.match(restore, /pg_verifybackup --no-parse-wal --exit-on-error "\$\{PITR_RESTORE_DATA_DIR\}"/);
  assert.doesNotMatch(restore, /pg_verifybackup --format=tar/);
  assert.ok(
    restore.indexOf('tar -xzf')
      < restore.indexOf('pg_verifybackup --no-parse-wal --exit-on-error "${PITR_RESTORE_DATA_DIR}"'),
  );
  assert.match(restore, /recovery\.signal/);
  assert.match(restore, /recovery_target_action = 'pause'/);
  assert.match(service, /pitr-run-candidate-job\.sh" lunchlineup-pitr-base-backup\.service/);
  const candidateRunner = read('scripts/pitr-run-candidate-job.sh');
  assert.match(candidateRunner, /run --detach --no-deps --pull never "\$compose_service"/);
  assert.match(candidateRunner, /container_status="\$\(docker wait "\$container_id"\)"/);
  assert.match(candidateRunner, /docker rm -f "\$target_id"/);
  assert.match(candidateRunner, /docker ps -a --no-trunc --filter "id=\$target_id"/);
  assert.doesNotMatch(candidateRunner, /run --rm --no-deps/);
  assert.match(timer, /Persistent=true/);
  assert.match(storageVerifier, /version info/);
  assert.match(storageVerifier, /retention info --default/);
  assert.match(storageVerifier, /identity can create delete markers/);
  assert.match(storageVerifier, /pitr_mc rm --force/);
  assert.match(storageVerifier, /pitr_mc rm --version-id "\$\{PROBE_VERSION\}" --force/);
  assert.match(storageVerifier, /pitr_exact_stat_version/);
  assert.match(lifecycleExporter, /pitr_mc ilm rule export/);
  assert.match(lifecycleVerifier, /configuredUpperBoundDays/);
  assert.match(lifecycleVerifier, /ExpiredObjectDeleteMarker/);
  assert.match(storagePreflight, /PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR/);
  assert.match(storagePreflight, /run_authorization_simulation[\s\S]*restore "\$restore_dir"/);
  assert.match(storagePreflight, /run_authorization_simulation[\s\S]*lifecycle-audit "\$lifecycle_audit_dir"/);
  assert.match(storagePreflight, /s3:PutObject,s3:DeleteObject,s3:DeleteObjectVersion/);
  assert.match(storagePreflight, /--proof-file/);
  assert.match(storagePreflight, /restore=provider-simulated-read-only/);
  assert.match(storagePreflight, /lifecycle_audit=provider-simulated-read-only/);
  assert.match(storagePreflight, /pitr-verify-authorization-simulation\.mjs/);
  assert.match(runbook, /pg_stat_archiver/);
  assert.match(runbook, /postgres_pitr_restore_data/);
  assert.match(runbook, /pg_wal_replay_resume/);
  assert.match(runbook, /Do not delete or reuse the original volume/);
});
