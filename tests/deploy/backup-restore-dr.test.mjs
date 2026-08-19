import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

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

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function createBackupFixture(name = 'lunchlineup-20260709000000.sql.zst.gpg', withChecksum = true) {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-backup-dr-'));
  const backupFile = join(scratch, name);
  const payload = 'encrypted fixture placeholder\n';
  writeFileSync(backupFile, payload);

  if (withChecksum) {
    const hash = createHash('sha256').update(payload).digest('hex');
    writeFileSync(`${backupFile}.sha256`, `${hash}  ${name}\n`);
  }

  return { scratch, backupFile: bashPath(backupFile), nativeBackupFile: backupFile };
}

const adapterIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const adapterIssuer = 'https://token.actions.githubusercontent.com';
const productionSystemIdentifier = '7123456789012345678';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createSignedAdapterFixture(scratch, fetchSha256, readbackSha256) {
  const attestationFile = join(scratch, 'recovery-adapter-attestation.json');
  const signatureFile = join(scratch, 'recovery-adapter-attestation.sigstore.json');
  const attestationUri = 'https://evidence.example/recovery/adapter-attestation-20260716.json';
  const signatureUri = 'https://evidence.example/recovery/adapter-attestation-20260716.sigstore.json';
  const now = Date.now();
  writeFileSync(attestationFile, JSON.stringify({
    version: 1,
    kind: 'lunchlineup-signed-recovery-adapter-provenance',
    fetchAdapterSha256: fetchSha256,
    readbackAdapterSha256: readbackSha256,
    sourceKinds: ['s3'],
    certificateIdentity: adapterIdentity,
    oidcIssuer: adapterIssuer,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  }));
  writeFileSync(signatureFile, JSON.stringify({ fixture: 'valid-sigstore-bundle' }));
  return {
    attestationFile,
    signatureFile,
    attestationUri,
    signatureUri,
    attestationSha256: createHash('sha256').update(readFileSync(attestationFile)).digest('hex'),
    signatureSha256: createHash('sha256').update(readFileSync(signatureFile)).digest('hex'),
    identity: adapterIdentity,
    issuer: adapterIssuer,
    fetchSha256,
    readbackSha256,
  };
}

function createProductionTargetFixture(scratch, overrides = {}) {
  const descriptorFile = join(scratch, `production-target-${Math.random().toString(16).slice(2)}.json`);
  const targetPinFile = join(scratch, `production-target-pin-${Math.random().toString(16).slice(2)}.json`);
  const targetPinSignatureFile = `${targetPinFile}.sigstore.json`;
  const now = Date.now();
  const descriptor = {
    version: 1,
    kind: 'lunchlineup-protected-production-database-target',
    environment: 'production',
    clusterId: 'production-cluster-a',
    postgres: {
      host: 'prod-db.internal',
      port: 5432,
      database: 'lunchlineup',
      ownerUsername: 'postgres',
      systemIdentifier: productionSystemIdentifier,
    },
    migration: { host: 'prod-db.internal', port: 5432, database: 'lunchlineup', username: 'postgres' },
    ...overrides,
  };
  writeFileSync(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
  writeFileSync(targetPinFile, JSON.stringify({
    version: 1,
    kind: 'lunchlineup-signed-production-database-target-pin',
    environment: 'production',
    clusterId: 'production-cluster-a',
    postgres: {
      host: 'prod-db.internal',
      port: 5432,
      database: 'lunchlineup',
      ownerUsername: 'postgres',
      systemIdentifier: productionSystemIdentifier,
    },
    certificateIdentity: adapterIdentity,
    oidcIssuer: adapterIssuer,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
  }), { mode: 0o600 });
  writeFileSync(targetPinSignatureFile, JSON.stringify({ fixture: 'valid-target-pin-signature' }), { mode: 0o600 });
  const descriptorSha256 = createHash('sha256').update(readFileSync(descriptorFile)).digest('hex');
  const targetPinSha256 = createHash('sha256').update(readFileSync(targetPinFile)).digest('hex');
  return {
    descriptor,
    descriptorFile,
    descriptorSha256,
    env: {
      POSTGRES_HOST: 'prod-db.internal',
      POSTGRES_PORT: '5432',
      POSTGRES_DB: 'lunchlineup',
      POSTGRES_USER: 'postgres',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:owner-password@prod-db.internal:5432/lunchlineup',
      RESTORE_PRODUCTION_CLUSTER_ID: 'production-cluster-a',
      RESTORE_PRODUCTION_TARGET_DESCRIPTOR_FILE: bashPath(descriptorFile),
      RESTORE_PRODUCTION_TARGET_DESCRIPTOR_SHA256: descriptorSha256,
      RESTORE_PRODUCTION_TARGET_PIN_FILE: bashPath(targetPinFile),
      RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE: bashPath(targetPinSignatureFile),
      RESTORE_CONFIRM: `restore-production-target:production-cluster-a:lunchlineup:${targetPinSha256}:${descriptorSha256}`,
    },
  };
}

function productionRestoreProvenance(backupFile, adapter, overrides = {}) {
  const sourceUri = `s3://lunchlineup-prod/db-backups/${backupFile.split(/[\\/]/).at(-1)}`;
  const sourceVersion = 'provider-version-production-20260716';
  const payload = readFileSync(backupFile);
  return {
    sourceUri,
    sourceVersion,
    proof: {
      version: 2,
      kind: 'lunchlineup-provider-authenticated-object-readback',
      sourceKind: 's3',
      sourceUri,
      requestedVersion: sourceVersion,
      resolvedVersion: sourceVersion,
      objectChecksum: { algorithm: 'sha256', value: createHash('sha256').update(payload).digest('hex') },
      bytes: payload.byteLength,
      readbackCommandSha256: adapter.readbackSha256,
      authentication: {
        status: 'verified',
        mechanism: 'provider-api',
        principal: 'arn:aws:iam::123456789012:role/production-restore-readback',
        requestId: 'production-restore-request-1234',
      },
      observedAt: new Date().toISOString(),
      source_fetch_command_sha256: adapter.fetchSha256,
      source_readback_command_sha256: adapter.readbackSha256,
      source_adapter_attestation_uri: adapter.attestationUri,
      source_adapter_attestation_sha256: adapter.attestationSha256,
      source_adapter_signature_bundle_uri: adapter.signatureUri,
      source_adapter_signature_bundle_sha256: adapter.signatureSha256,
      source_adapter_certificate_identity: adapter.identity,
      source_adapter_oidc_issuer: adapter.issuer,
      ...overrides,
    },
  };
}

function productionRestoreExecution(scratch, provenance, provenanceSha256) {
  const attestationFile = join(scratch, 'dr-execution-attestation.json');
  const signatureFile = join(scratch, 'dr-execution-attestation.sigstore.json');
  const observedAt = provenance.proof.observedAt;
  const completedAt = observedAt;
  const startedAt = new Date(Date.parse(observedAt) - 60_000).toISOString();
  const releaseSha = 'e'.repeat(40);
  const binding = {
    run: { id: 'production-dr-run-20260716', releaseSha, startedAt, completedAt },
    source: {
      kind: provenance.proof.sourceKind,
      uri: provenance.sourceUri,
      version: provenance.sourceVersion,
      checksum: provenance.proof.objectChecksum,
      bytes: provenance.proof.bytes,
    },
    providerReadback: {
      principal: provenance.proof.authentication.principal,
      requestId: provenance.proof.authentication.requestId,
      observedAt,
      sha256: provenanceSha256,
    },
    target: {
      environment: 'isolated-recovery',
      identity: 'isolated-postgres-dr-fixture',
      systemIdentifier: '8123456789012345678',
    },
    outcome: { status: 'succeeded', restoredTableCount: 12, appRoleVerified: true },
  };
  writeFileSync(attestationFile, JSON.stringify({
    version: 1,
    kind: 'lunchlineup-signed-recovery-execution-proof',
    certificateIdentity: adapterIdentity,
    oidcIssuer: adapterIssuer,
    bindingSha256: createHash('sha256').update(canonicalJson(binding)).digest('hex'),
    binding,
    issuedAt: completedAt,
    expiresAt: new Date(Date.parse(completedAt) + 86_400_000).toISOString(),
  }), { mode: 0o600 });
  writeFileSync(signatureFile, JSON.stringify({ fixture: 'valid-dr-execution-signature' }), { mode: 0o600 });
  return {
    env: {
      RESTORE_DR_EXECUTION_ATTESTATION_FILE: bashPath(attestationFile),
      RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE: bashPath(signatureFile),
      RESTORE_DR_EXECUTION_ATTESTATION_URI: 'https://evidence.example/recovery/dr-execution-20260716.json',
      RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_URI: 'https://evidence.example/recovery/dr-execution-20260716.sigstore.json',
      RESTORE_DR_RELEASE_SHA: releaseSha,
    },
  };
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
}

function createOffhostDrFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-offhost-dr-'));
  const fakeBin = join(scratch, 'bin');
  const remoteDir = join(scratch, 'remote');
  const destinationDir = join(scratch, 'destination');
  const objectName = 'lunchlineup-20260716000000.sql.zst.gpg';
  const remoteObject = join(remoteDir, objectName);
  const backupFile = join(destinationDir, objectName);
  const readbackFile = `${backupFile}.offhost-readback.json`;
  const proofFile = join(scratch, 'dr-proof.json');
  const dockerLog = join(scratch, 'docker.log');
  const dockerState = join(scratch, 'docker.state');
  const dockerReplacementState = join(scratch, 'docker-replacement.state');
  const adapterExecLog = join(scratch, 'adapter-exec.log');
  const cosignLog = join(scratch, 'cosign.log');
  const fetchCommand = join(scratch, 'fetch-offhost');
  const readbackCommand = join(scratch, 'readback-offhost');
  const sourceUri = `s3://lunchlineup-prod/db-backups/${objectName}`;
  const sourceVersion = 'version-20260716-immutable';
  const payload = 'encrypted off-host fixture payload\n';
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');

  mkdirSync(fakeBin);
  mkdirSync(remoteDir);
  mkdirSync(destinationDir);
  writeFileSync(remoteObject, payload);
  writeExecutable(fetchCommand, `#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${FAKE_ADAPTER_EXEC_LOG:-}" ]] || printf 'fetch|%s\n' "$0" >>"$FAKE_ADAPTER_EXEC_LOG"
[[ "$DR_FETCH_SOURCE_URI" == "$FAKE_REMOTE_URI" ]] || exit 44
[[ "$DR_FETCH_SOURCE_VERSION" == "$FAKE_REMOTE_VERSION" ]] || exit 45
cp -- "$FAKE_REMOTE_OBJECT" "$DR_FETCH_BACKUP_OUTPUT"
`);
  writeExecutable(readbackCommand, `#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${FAKE_ADAPTER_EXEC_LOG:-}" ]] || printf 'readback|%s\n' "$0" >>"$FAKE_ADAPTER_EXEC_LOG"
[[ "$DR_READBACK_SOURCE_URI" == "$FAKE_REMOTE_URI" ]] || exit 54
[[ "$DR_READBACK_REQUESTED_VERSION" == "$FAKE_REMOTE_VERSION" ]] || exit 55
  resolved_version="\${FAKE_READBACK_RESOLVED_VERSION:-$FAKE_REMOTE_VERSION}"
  checksum="\${FAKE_READBACK_SHA256:-$(sha256sum -- "$FAKE_REMOTE_OBJECT" | awk '{print tolower($1)}')}"
  auth_status="\${FAKE_READBACK_AUTH_STATUS:-verified}"
  principal="\${FAKE_READBACK_PRINCIPAL-arn:aws:iam::123456789012:role/dr-readback}"
  request_id="\${FAKE_READBACK_REQUEST_ID-fixture-request-1234}"
  observed_at="\${FAKE_READBACK_OBSERVED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  bytes="$(stat -c '%s' -- "$FAKE_REMOTE_OBJECT")"
  cat > "$DR_READBACK_OUTPUT" <<JSON
  {"version":2,"kind":"lunchlineup-provider-authenticated-object-readback","sourceKind":"$DR_READBACK_SOURCE_KIND","sourceUri":"$DR_READBACK_SOURCE_URI","requestedVersion":"$DR_READBACK_REQUESTED_VERSION","resolvedVersion":"$resolved_version","objectChecksum":{"algorithm":"sha256","value":"$checksum"},"bytes":$bytes,"readbackCommandSha256":"$DR_READBACK_COMMAND_SHA256","authentication":{"status":"$auth_status","mechanism":"provider-api","principal":"$principal","requestId":"$request_id"},"observedAt":"$observed_at"}
JSON
`);
  const fetchSha256 = createHash('sha256').update(readFileSync(fetchCommand)).digest('hex');
  const readbackSha256 = createHash('sha256').update(readFileSync(readbackCommand)).digest('hex');
  const adapter = createSignedAdapterFixture(scratch, fetchSha256, readbackSha256);
  writeExecutable(join(fakeBin, 'timeout'), `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${1:-}" == --* ]]; do shift; done
[[ "\${1:-}" =~ ^[0-9]+s$ ]] && shift
exec "$@"
`);
  writeExecutable(join(fakeBin, 'setsid'), `#!/usr/bin/env bash
exec "$@"
`);
  writeExecutable(join(fakeBin, 'cosign'), `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FAKE_COSIGN_FAIL:-false}" != "true" ]]
printf '%s|%s\n' "$2" "$4" >>"\${FAKE_COSIGN_LOG:?}"
for kind in ATTESTATION SIGNATURE FETCH READBACK; do
  original_name="FAKE_SWAP_\${kind}_ORIGINAL"
  replacement_name="FAKE_SWAP_\${kind}_REPLACEMENT"
  [[ -z "\${!original_name:-}" ]] || mv -f -- "\${!replacement_name}" "\${!original_name}"
done
`);
  writeExecutable(join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == - && "\${2:-}" == *lunchlineup-dr-evidence.*/provider-readback.json ]]; then
  if [[ -n "\${FAKE_SWAP_READBACK_EVIDENCE_ORIGINAL:-}" ]]; then
    mv -f -- "$FAKE_SWAP_READBACK_EVIDENCE_REPLACEMENT" "$FAKE_SWAP_READBACK_EVIDENCE_ORIGINAL"
  fi
fi
exec '${bashPath(process.execPath)}' "$@"
`);
  writeExecutable(join(fakeBin, 'gpg'), `#!/usr/bin/env bash
set -euo pipefail
backup="\${@: -1}"
if [[ -n "\${FAKE_SWAP_ORIGINAL:-}" ]]; then
  mv -f -- "$FAKE_SWAP_REPLACEMENT" "$FAKE_SWAP_ORIGINAL"
fi
if [[ -n "\${FAKE_GPG_LOG:-}" ]]; then
  printf '%s\\n' "$backup" > "$FAKE_GPG_LOG"
fi
cat -- "$backup"
`);
  writeExecutable(join(fakeBin, 'zstd'), `#!/usr/bin/env bash
cat
`);
  writeExecutable(join(fakeBin, 'docker'), `#!/usr/bin/env bash
  set -euo pipefail
  if [[ -n "\${FAKE_SECRET_SENTINEL:-}" && -r /proc/$$/cmdline ]]; then
    ! tr '\\000' '\\n' </proc/$$/cmdline | grep -Fq -- "$FAKE_SECRET_SENTINEL" || exit 88
  fi
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
  state_file="\${FAKE_DOCKER_STATE:-\${FAKE_DOCKER_LOG}.state}"
  replacement_file="\${FAKE_DOCKER_REPLACEMENT_STATE:-\${state_file}.replacement}"
  removed_marker="\${state_file}.removed"
  query_marker="\${state_file}.query"
  container_id='${'d'.repeat(64)}'
  replacement_id='${'e'.repeat(64)}'
  case "\${1:-}" in
  ps)
    if [[ "\${FAKE_DOCKER_PS_FAIL_AFTER_RM:-false}" == true && -f "$removed_marker" ]]; then exit 67; fi
    if [[ "\${FAKE_DOCKER_REPLACE_BEFORE_CLEANUP:-false}" == true && -f "$query_marker" && -f "$state_file" && ! -f "$replacement_file" ]]; then
      IFS='|' read -r current_id current_name < "$state_file"
      printf '%s|renamed-%s\n' "$current_id" "$current_name" > "$state_file"
      printf '%s|%s\n' "$replacement_id" "$current_name" > "$replacement_file"
    fi
    requested_filter=''
    previous=''
    for argument in "$@"; do
      [[ "$previous" != '--filter' ]] || requested_filter="$argument"
      previous="$argument"
    done
    for candidate in "$state_file" "$replacement_file"; do
      [[ -f "$candidate" ]] || continue
      IFS='|' read -r candidate_id candidate_name < "$candidate"
      case "$requested_filter" in
        id=*) [[ "$candidate_id" == "\${requested_filter#id=}"* ]] && printf '%s\\n' "$candidate_id" ;;
        name=*) [[ "$requested_filter" == "name=^/$candidate_name$" ]] && printf '%s\\n' "$candidate_id" ;;
      esac
    done
    exit 0
    ;;
  run)
    shift
    container_name=''
    env_file=''
    previous=''
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == --name ]]; then container_name="$2"; shift 2; continue; fi
      if [[ "$1" == --env-file ]]; then env_file="$2"; shift 2; continue; fi
      shift
    done
    [[ -n "$container_name" && -n "$env_file" && "$(stat -c '%a' -- "$env_file")" == 600 ]]
    [[ -z "\${FAKE_SECRET_SENTINEL:-}" ]] || grep -Fq -- "POSTGRES_PASSWORD=$FAKE_SECRET_SENTINEL" "$env_file"
    printf '%s|%s\n' "$container_id" "$container_name" > "$state_file"
    printf '%s\\n' "$container_id"
    exit 0
    ;;
  rm)
    [[ "\${FAKE_DOCKER_RM_FAIL:-false}" != true ]] || exit 66
    target="\${@: -1}"
    if [[ -f "$state_file" ]]; then
      IFS='|' read -r current_id _ < "$state_file"
      [[ "$target" != "$current_id" ]] || rm -f "$state_file"
    fi
    if [[ -f "$replacement_file" ]]; then
      IFS='|' read -r current_id _ < "$replacement_file"
      [[ "$target" != "$current_id" ]] || rm -f "$replacement_file"
    fi
    touch "$removed_marker"
    exit 0
    ;;
  exec)
    if [[ " $* " == *" pg_isready "* ]]; then
      [[ -z "\${FAKE_READINESS_MARKER:-}" ]] || touch "$FAKE_READINESS_MARKER"
      exit 0
    fi
    if [[ " $* " == *" -c "* ]]; then touch "$query_marker"; printf '1\\n'; exit 0; fi
    if [[ -n "\${FAKE_RESTORE_STDIN_LOG:-}" ]]; then cat > "$FAKE_RESTORE_STDIN_LOG"; else cat >/dev/null; fi
    exit 0
    ;;
esac
exit 91
`);

  return {
    scratch,
    fakeBin,
    remoteObject,
    backupFile,
    readbackFile,
    proofFile,
    dockerLog,
    dockerState,
    dockerReplacementState,
    adapterExecLog,
    cosignLog,
    fetchCommand,
    readbackCommand,
    sourceUri,
    sourceVersion,
    expectedSha256,
    adapter,
    adapterEnv: {
      DR_RECOVERY_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
      DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
      DR_RECOVERY_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
      DR_RECOVERY_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
      DR_RECOVERY_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
      DR_RECOVERY_ADAPTER_OIDC_ISSUER: adapter.issuer,
      FAKE_COSIGN_LOG: bashPath(cosignLog),
    },
  };
}

function runBashScript(bash, script, env = {}, args = []) {
  return spawnSync(bash, [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runBashScriptWithBin(bash, fakeBin, script, env = {}, args = [], options = {}) {
  const { env: optionEnv = {}, ...spawnOptions } = options;
  return spawnSync(bash, [
    '-c',
    `fake_bin="$1"; PATH="$fake_bin:$PATH"; export PATH
if [ -x "$fake_bin/timeout" ]; then
  timeout() {
    while [[ "\${1:-}" == --* ]]; do shift; done
    [[ "\${1:-}" =~ ^[0-9]+s$ ]] && shift
    "$@"
  }
  export -f timeout
fi
shift
exec bash "$@"`,
    'dr-fixture',
    bashPath(fakeBin),
    bashPath(join(root, script)),
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    ...spawnOptions,
    env: { ...process.env, ...env, ...optionEnv },
  });
}

const bash = findBash();
const bashSkip = bash ? false : 'Bash is not available';
const cgroupOwnerAvailable = process.platform !== 'win32' && bash && commandWorks(bash, ['-c', `
set -eu
path="$(sed -n 's/^0:://p' /proc/self/cgroup)"
parent="/sys/fs/cgroup$path"
domain="$(mktemp -d "$parent/lunchlineup-test-owner.XXXXXX" 2>/dev/null)"
trap 'rmdir "$domain" 2>/dev/null || true' EXIT
test -w "$domain/cgroup.procs"
test -w "$domain/cgroup.kill"
grep -q '^populated 0$' "$domain/cgroup.events"
`]);
const cgroupOwnerSkip = cgroupOwnerAvailable
  ? false
  : 'a writable delegated cgroup v2 is required for provider ownership tests';
const processTreeSkip = cgroupOwnerAvailable && commandWorks('setsid', ['--help'])
  ? false
  : cgroupOwnerSkip || 'setsid is required for descendant-escape coverage';

test('backup, restore, DR, and retention purge scripts expose machine-checkable proof contracts', () => {
  const backup = read('scripts/backup.sh');
  const restore = read('scripts/restore.sh');
  const drill = read('scripts/dr-drill.sh');
  const retentionPurge = read('scripts/invoke-retained-record-purge.mjs');

  assert.match(backup, /backup_ok backup_file=/);
  assert.match(backup, /BACKUP_RETENTION_DAYS="\$\{BACKUP_RETENTION_DAYS:-35\}"/);
  assert.match(backup, /BACKUP_OFFSITE_RETENTION_DAYS="\$\{BACKUP_OFFSITE_RETENTION_DAYS:-35\}"/);
  assert.match(backup, /offsite_retention_ok mode=lifecycle_owned/);
  assert.match(backup, /--if-none-match '\*'/);
  assert.match(backup, /--object-lock-mode COMPLIANCE/);
  assert.match(backup, /offsite_immutable_ok object_version=/);
  assert.match(backup, /Mutable rclone repositories cannot satisfy immutable production logical-backup proof/);
  assert.doesNotMatch(backup, /aws s3 rm|rclone purge|rclone delete/);
  assert.match(backup, /lunchlineup-provider\.XXXXXX/);
  assert.match(backup, /cgroup\.kill/);
  assert.match(backup, /cgroup\.events/);
  assert.match(backup, /kill -STOP/);
  assert.match(backup, /ownership domain could not be proven empty/);
  assert.match(backup, /printf '%s  %s\\n' "\$\{BACKUP_SHA256\}" "\$\(basename "\$\{BACKUP_FILE\}"\)"/);

  assert.match(restore, /RESTORE_REQUIRE_CHECKSUM/);
  assert.match(restore, /restore_ok target_env=/);
  assert.match(restore, /restored_table_count=/);
  assert.match(restore, /RESTORE_REHYDRATE_DURABLE_QUEUES/);
  assert.match(restore, /rehydrate-durable-queues\.sql/);
  assert.match(restore, /RESTORE_MUTATION_TIMEOUT_SECONDS="\$\{RESTORE_MUTATION_TIMEOUT_SECONDS:-600\}"/);
  assert.match(restore, /RESTORE_MUTATION_TIMEOUT_SECONDS must be between 1 and 600/);
  assert.match(restore, /run_bounded_command\(\)/);
  assert.match(restore, /run-bounded-command\.mjs/);
  assert.match(read('scripts/run-bounded-command.mjs'), /runBoundedProcessResult/);
  assert.match(read('scripts/run-bounded-command.mjs'), /process\.exit\(124\)/);

  const rehydrate = read('scripts/rehydrate-durable-queues.sql');
  assert.match(rehydrate, /"publicationStatus" = 'PUBLISHED'/);
  assert.match(rehydrate, /"status" IN \('QUEUED', 'RUNNING', 'RETRYING'\)/);
  assert.match(rehydrate, /"status" = 'QUEUED'::"WebhookDeliveryStatus"/);
  assert.doesNotMatch(rehydrate, /DELIVERED|DEAD_LETTERED/);

  assert.match(drill, /DR_OFFHOST_SOURCE_URI/);
  assert.match(drill, /DR_OFFHOST_SOURCE_VERSION/);
  assert.match(drill, /DR_OFFHOST_EXPECTED_SHA256/);
  assert.match(drill, /DR_OFFHOST_FETCH_COMMAND/);
  assert.match(drill, /DR_OFFHOST_READBACK_COMMAND/);
  assert.match(drill, /lunchlineup-dr-adapter\.XXXXXX/);
  assert.match(drill, /cgroup\.kill/);
  assert.match(drill, /cgroup\.events/);
  assert.match(drill, /kill -STOP/);
  assert.match(drill, /ownership domain could not be proven empty/);
  assert.doesNotMatch(drill, /setsid "\$@"/);
  assert.match(drill, /run_adapter_process_tree_bounded \\\n\s*"\$\{DR_OFFHOST_FETCH_TIMEOUT_SECONDS\}"/);
  assert.match(drill, /run_adapter_process_tree_bounded \\\n\s*"\$\{DR_OFFHOST_READBACK_TIMEOUT_SECONDS\}"/);
  assert.match(drill, /source_readback_verified/);
  assert.match(drill, /lunchlineup-signed-recovery-adapter-provenance/);
  assert.match(drill, /cosign verify-blob/);
  for (const boundedPhase of ['docker', 'gpg', 'zstd', 'psql']) {
    assert.match(drill, new RegExp(`run_bounded[\\s\\S]*${boundedPhase}`, 'i'));
  }
  assert.match(drill, /DR_RESTORE_PIPELINE_TIMEOUT_SECONDS/);
  assert.match(drill, /DR_RESTORE_PIPELINE_TIMEOUT_SECONDS="\$\{DR_RESTORE_PIPELINE_TIMEOUT_SECONDS:-600\}"/);
  assert.match(drill, /\$timeout_name must be between 1 and 600/);
  assert.match(drill, /snapshot_regular_file_once[\s\S]*adapter-attestation\.json/);
  assert.match(drill, /snapshot_regular_file_once[\s\S]*provider-readback\.json/);
  assert.match(drill, /DR_CLEANUP_TIMEOUT_SECONDS/);
  assert.match(drill, /source_fetch_command_sha256/);
  assert.match(drill, /DR_REQUIRE_OFFHOST_SOURCE/);
  assert.match(drill, /DR_REQUIRE_CHECKSUM/);
  assert.match(drill, /DR_PROOF_FILE/);
  assert.match(drill, /dr_drill_ok backup_sha256=/);
  assert.match(drill, /"completed_at": "\$\(json_escape "\$\{completed_at\}"\)"/);
  assert.match(drill, /"checked_at": "\$\(json_escape "\$\{completed_at\}"\)"/);
  assert.match(drill, /"source_sha": "\$\(json_escape "\$\{DR_SOURCE_SHA\}"\)"/);
  assert.match(drill, /DR_CONTAINER must start with lunchlineup-dr-drill-/);
  assert.match(drill, /postgres:16-alpine@sha256:/);
  assert.match(drill, /DR_IMAGE must include an immutable @sha256 digest/);

  assert.match(retentionPurge, /RETENTION_PURGE_URL/);
  assert.match(retentionPurge, /RETENTION_PURGE_TOKEN_FILE/);
  assert.match(retentionPurge, /purge-expired-retained-records/);
  assert.match(retentionPurge, /lunchlineup_retention_purge_last_attempt_timestamp_seconds/);
  assert.match(retentionPurge, /candidateSchedule/);
  assert.match(retentionPurge, /sessionEligibleCount/);
  assert.match(retentionPurge, /sessionPurgedCount/);
  assert.match(retentionPurge, /retention_purge_ok/);
});

test('retained-record purge dry-run invocation writes proof and Prometheus metrics', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');
  const seen = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.method = request.method;
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      seen.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [
          {
            id: 'tenant_123',
            slug: 'acme-dining',
            eligibleForDatabasePurge: true,
            retention: {
              deletionRequestedAt: '2019-07-09T00:00:00.000Z',
              fullDatabasePurgeEligibleAt: '2026-07-09T00:00:00.000Z',
            },
          },
        ],
        deletedCounts: {
          tenants: 0,
          users: 0,
        },
      }));
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const result = await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
          RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v2/admin/retention/purge-expired`,
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_METRICS_FILE: metricsPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    assert.match(result.stdout, /retention_purge_ok mode=dry_run/);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v2/admin/retention/purge-expired');
    assert.equal(seen.authorization, 'Bearer test-retention-token');
    assert.deepEqual(JSON.parse(seen.body), { dryRun: true, stage: 'retained_records' });

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'ok');
    assert.equal(proof.mode, 'dry_run');
    assert.equal(proof.candidateTenantCount, 1);
    assert.equal(proof.deletedRecordCount, 0);
    assert.deepEqual(proof.candidateSchedule, [
      {
        tenantId: 'tenant_123',
        deletionRequestedAt: '2019-07-09T00:00:00.000Z',
        eligibleAt: '2026-07-09T00:00:00.000Z',
      },
    ]);
    assert.match(proof.responseSha256, /^[a-f0-9]{64}$/);

    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_attempt_timestamp_seconds\{mode="dry_run",stage="retained_records"\}/);
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="dry_run",stage="retained_records"\} 1/);
    assert.match(metrics, /lunchlineup_retention_purge_last_candidate_tenants\{mode="dry_run",stage="retained_records"\} 1/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retained-record purge execution sends API confirmation', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-execute-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const lockPath = join(scratch, 'retention.lock');
  const seen = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.method = request.method;
      seen.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [],
        purgedTenants: [
          {
            id: 'tenant_123',
            deleted: true,
            deletedRecordCounts: {
              users: 1,
              sessions: 2,
            },
          },
        ],
      }));
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const result = await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v2/admin/retention/purge-expired`,
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_DRY_RUN: 'false',
        RETENTION_PURGE_EXECUTE_CONFIRM: 'purge-expired-retained-records',
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    assert.match(result.stdout, /retention_purge_ok mode=execute/);
    assert.equal(seen.method, 'POST');
    assert.deepEqual(JSON.parse(seen.body), {
      dryRun: false,
      stage: 'retained_records',
      executeConfirmation: 'purge-expired-retained-records',
    });

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'ok');
    assert.equal(proof.mode, 'execute');
    assert.equal(proof.deletedRecordCount, 3);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retention purge continues past failed oldest tenants and fails the overall bounded run', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-pages-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (!body.continuation) {
        response.end(JSON.stringify({
          candidates: [{ id: 'tenant-old', deletedAt: '2026-01-01T00:00:00.000Z' }],
          failedTenants: [{ id: 'tenant-old', error: 'simulated timeout' }],
          failedTenantCount: 1,
          processedTenantCount: 1,
          pendingDeletionBillingCandidates: [{ id: 'tenant-pending', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }],
          reconciledDeletionTenants: [{ id: 'tenant-recovered', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }],
          sessionRetention: {
            expiredGraceHours: 24,
            revokedRetentionDays: 30,
            batchLimit: 5000,
            expiredBefore: '2026-07-13T00:00:00.000Z',
            revokedBefore: '2026-06-14T00:00:00.000Z',
            eligibleCount: 7,
            purgedCount: 5,
          },
          nextContinuation: { deletedAt: '2026-01-01T00:00:00.000Z', id: 'tenant-old' },
        }));
      } else {
        response.end(JSON.stringify({
          candidates: [{ id: 'tenant-new', deletedAt: '2026-02-01T00:00:00.000Z' }],
          applicationDataPurgedTenants: [{ id: 'tenant-new', deletedRecordCounts: { users: 2 } }],
          processedTenantCount: 1,
          skippedTenants: [{ id: 'tenant-busy', reason: 'already claimed' }],
          skippedTenantCount: 1,
          nextContinuation: null,
        }));
      }
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    let failure;
    try {
      await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
        RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v2/admin/retention/purge-expired`,
          RETENTION_PURGE_TOKEN_FILE: tokenPath,
          RETENTION_PURGE_DRY_RUN: 'false',
          RETENTION_PURGE_STAGE: 'application_data',
          RETENTION_PURGE_EXECUTE_CONFIRM: 'purge-expired-application-data',
          RETENTION_PURGE_PROOF_FILE: proofPath,
          RETENTION_PURGE_METRICS_FILE: metricsPath,
          RETENTION_PURGE_LOCK_FILE: lockPath,
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'failedTenants must make the wrapper exit nonzero');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].continuation, { deletedAt: '2026-01-01T00:00:00.000Z', id: 'tenant-old' });
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'failed');
    assert.equal(proof.pageCount, 2);
    assert.equal(proof.failedTenantCount, 1);
    assert.equal(proof.skippedTenantCount, 1);
    assert.equal(proof.processedTenantCount, 2);
    assert.deepEqual(proof.pendingDeletionBillingCandidates, [{ id: 'tenant-pending', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(proof.reconciledDeletionTenants, [{ id: 'tenant-recovered', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }]);
    assert.equal(proof.sessionEligibleCount, 7);
    assert.equal(proof.sessionPurgedCount, 5);
    assert.deepEqual(proof.sessionRetention, {
      expiredGraceHours: 24,
      revokedRetentionDays: 30,
      batchLimit: 5000,
      expiredBefore: '2026-07-13T00:00:00.000Z',
      revokedBefore: '2026-06-14T00:00:00.000Z',
      eligibleCount: 7,
      purgedCount: 5,
    });
    assert.deepEqual(proof.failedTenants, [{ id: 'tenant-old', error: 'simulated timeout' }]);
    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="execute",stage="application_data"\} 0/);
    assert.match(metrics, /lunchlineup_retention_purge_last_failed_tenants\{mode="execute",stage="application_data"\} 1/);
    assert.match(metrics, /lunchlineup_retention_purge_last_skipped_tenants\{mode="execute",stage="application_data"\} 1/);
    assert.match(metrics, /lunchlineup_retention_purge_last_eligible_sessions\{mode="execute",stage="application_data"\} 7/);
    assert.match(metrics, /lunchlineup_retention_purge_last_purged_sessions\{mode="execute",stage="application_data"\} 5/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retained-record purge execution fails closed without confirmation before network', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-confirm-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    const result = spawnSync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RETENTION_PURGE_URL: 'http://127.0.0.1:1/api/v2/admin/retention/purge-expired',
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_DRY_RUN: 'false',
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_METRICS_FILE: metricsPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records is required for retained_records execution/);

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'failed');
    assert.equal(proof.mode, 'execute');
    assert.equal(proof.httpStatus, 0);

    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="execute",stage="retained_records"\} 0/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects missing off-host source before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_OFFHOST_SOURCE_URI is required/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill retrieves and readback-verifies the exact declared off-host object version and checksum', { skip: cgroupOwnerSkip }, () => {
  const fixture = createOffhostDrFixture();
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_SOURCE_SHA: 'a'.repeat(40),
      DR_WAIT_SECONDS: '2',
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
      FAKE_DOCKER_STATE: bashPath(fixture.dockerState),
      FAKE_DOCKER_REPLACEMENT_STATE: bashPath(fixture.dockerReplacementState),
      DR_PASSWORD: 'DR-PASSWORD-PROC-SENTINEL-7f49',
      FAKE_SECRET_SENTINEL: 'DR-PASSWORD-PROC-SENTINEL-7f49',
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /dr_drill_ok/);
    const proof = JSON.parse(readFileSync(fixture.proofFile, 'utf8'));
    assert.equal(proof.source_uri, fixture.sourceUri);
    assert.equal(proof.source_version, fixture.sourceVersion);
    assert.equal(proof.source_expected_sha256, fixture.expectedSha256);
    assert.equal(proof.backup_sha256, fixture.expectedSha256);
    assert.equal(proof.source_readback_verified, true);
    assert.match(proof.source_readback_sha256, /^[a-f0-9]{64}$/);
    assert.equal(proof.source_provider_version, fixture.sourceVersion);
    assert.equal(proof.source_readback_principal, 'arn:aws:iam::123456789012:role/dr-readback');
    assert.equal(proof.source_readback_request_id, 'fixture-request-1234');
    assert.match(proof.source_readback_observed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      createHash('sha256').update(Buffer.from(proof.source_readback_base64, 'base64')).digest('hex'),
      proof.source_readback_sha256,
    );
    assert.match(proof.source_fetch_command_sha256, /^[a-f0-9]{64}$/);
    assert.match(proof.source_readback_command_sha256, /^[a-f0-9]{64}$/);
    assert.equal(proof.source_retrieved_bytes, readFileSync(fixture.remoteObject).byteLength);
    assert.equal(proof.restored_table_count, 1);
    assert.equal(proof.cleanup_status, 'succeeded');
    assert.equal(proof.cleanup_container_absent, true);
    assert.equal(proof.cleanup_container, proof.container);
    assert.match(proof.container_id, /^[a-f0-9]{64}$/);
    assert.equal(proof.cleanup_container_id, proof.container_id);
    assert.equal(proof.cleanup_container_id_absent, true);
    assert.equal(proof.cleanup_container_name_absent, true);
    assert.equal(proof.cleanup_evidence, 'docker-ps-exact-name-v1');
    assert.equal(proof.cleanup_id_evidence, 'docker-ps-exact-id-v1');
    assert.match(proof.cleanup_checked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.parse(proof.cleanup_checked_at) <= Date.parse(proof.completed_at));
    assert.equal(existsSync(fixture.dockerState), false);
    const dockerArgv = readFileSync(fixture.dockerLog, 'utf8');
    assert.match(dockerArgv, new RegExp(`rm -f ${'d'.repeat(64)}`));
    assert.doesNotMatch(dockerArgv, /DR-PASSWORD-PROC-SENTINEL-7f49/);
    assert.doesNotMatch(JSON.stringify(proof), /DR-PASSWORD-PROC-SENTINEL-7f49/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill kills a TERM-ignoring fetch adapter tree before failed-output cleanup returns', { skip: processTreeSkip, timeout: 15_000 }, () => {
  const fixture = createOffhostDrFixture();
  const parentPidFile = join(fixture.scratch, 'fetch-parent.pid');
  const childPidFile = join(fixture.scratch, 'fetch-child.pid');
  rmSync(join(fixture.fakeBin, 'timeout'));
  rmSync(join(fixture.fakeBin, 'setsid'));
  writeExecutable(fixture.fetchCommand, `#!/usr/bin/env bash
set -euo pipefail
setsid --wait bash -c '
  trap "" TERM
  printf '%s\n' "$$" > "$FAKE_FETCH_CHILD_PID_FILE"
  sleep 7
  printf 'delayed rewrite\n' > "$DR_FETCH_BACKUP_OUTPUT"
  while :; do sleep 1; done
' &
child=$!
printf '%s\n' "$$" > "$FAKE_FETCH_PARENT_PID_FILE"
wait "$child"
`);
  const attestation = JSON.parse(readFileSync(fixture.adapter.attestationFile, 'utf8'));
  attestation.fetchAdapterSha256 = createHash('sha256').update(readFileSync(fixture.fetchCommand)).digest('hex');
  writeFileSync(fixture.adapter.attestationFile, JSON.stringify(attestation));

  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_OFFHOST_FETCH_TIMEOUT_SECONDS: '1',
      FAKE_FETCH_PARENT_PID_FILE: bashPath(parentPidFile),
      FAKE_FETCH_CHILD_PID_FILE: bashPath(childPidFile),
    }, [], { timeout: 12_000, killSignal: 'SIGKILL' });

    assert.equal(result.error?.code, undefined, 'adapter process tree escaped the outer test bound');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Off-host backup retrieval timed out after 1s/);
    const parentPid = readFileSync(parentPidFile, 'utf8').trim();
    const childPid = readFileSync(childPidFile, 'utf8').trim();
    const processCheck = spawnSync(bash, [
      '-c',
      'for pid in "$@"; do ! kill -0 "$pid" 2>/dev/null || exit 1; done',
      'adapter-process-check',
      parentPid,
      childPid,
    ], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
    assert.equal(processCheck.status, 0, `fetch adapter process survived: parent=${parentPid} child=${childPid}`);

    const delayedRewriteWindow = spawnSync(bash, ['-c', 'sleep 2'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
    });
    assert.equal(delayedRewriteWindow.status, 0);
    assert.equal(existsSync(fixture.backupFile), false, 'killed child recreated the cleaned backup output');
    assert.equal(existsSync(fixture.readbackFile), false);
    assert.equal(existsSync(fixture.proofFile), false);
    assert.equal(existsSync(fixture.dockerLog), false, 'restore must not start after adapter timeout');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill kills a setsid readback descendant before retrieved-output cleanup returns', { skip: processTreeSkip, timeout: 15_000 }, () => {
  const fixture = createOffhostDrFixture();
  const parentPidFile = join(fixture.scratch, 'readback-parent.pid');
  const childPidFile = join(fixture.scratch, 'readback-child.pid');
  rmSync(join(fixture.fakeBin, 'timeout'));
  rmSync(join(fixture.fakeBin, 'setsid'));
  writeExecutable(fixture.readbackCommand, `#!/usr/bin/env bash
set -euo pipefail
setsid --wait bash -c '
  trap "" TERM
  printf '%s\n' "$$" > "$FAKE_READBACK_CHILD_PID_FILE"
  sleep 7
  printf 'delayed readback rewrite\n' > "$DR_READBACK_OUTPUT"
  while :; do sleep 1; done
' &
child=$!
printf '%s\n' "$$" > "$FAKE_READBACK_PARENT_PID_FILE"
wait "$child"
`);
  const attestation = JSON.parse(readFileSync(fixture.adapter.attestationFile, 'utf8'));
  attestation.readbackAdapterSha256 = createHash('sha256').update(readFileSync(fixture.readbackCommand)).digest('hex');
  writeFileSync(fixture.adapter.attestationFile, JSON.stringify(attestation));

  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_OFFHOST_READBACK_TIMEOUT_SECONDS: '1',
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_READBACK_PARENT_PID_FILE: bashPath(parentPidFile),
      FAKE_READBACK_CHILD_PID_FILE: bashPath(childPidFile),
    }, [], { timeout: 12_000, killSignal: 'SIGKILL' });

    assert.equal(result.error?.code, undefined, 'readback ownership domain escaped the outer test bound');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Provider-authenticated off-host readback timed out after 1s/);
    const parentPid = readFileSync(parentPidFile, 'utf8').trim();
    const childPid = readFileSync(childPidFile, 'utf8').trim();
    const processCheck = spawnSync(bash, [
      '-c',
      'for pid in "$@"; do ! kill -0 "$pid" 2>/dev/null || exit 1; done',
      'readback-process-check',
      parentPid,
      childPid,
    ], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
    assert.equal(processCheck.status, 0, `readback adapter process survived: parent=${parentPid} child=${childPid}`);

    const delayedRewriteWindow = spawnSync(bash, ['-c', 'sleep 2'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
    });
    assert.equal(delayedRewriteWindow.status, 0);
    assert.equal(existsSync(fixture.backupFile), false, 'readback descendant recreated the cleaned backup output');
    assert.equal(existsSync(fixture.readbackFile), false, 'readback descendant recreated cleaned provider evidence');
    assert.equal(existsSync(fixture.proofFile), false);
    assert.equal(existsSync(fixture.dockerLog), false, 'restore must not start after readback timeout');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill decrypts only its provider-bound private backup snapshot after an atomic source replacement', { skip: cgroupOwnerSkip }, () => {
  const fixture = createOffhostDrFixture();
  const replacement = join(fixture.scratch, 'replacement.sql.zst.gpg');
  const gpgLog = join(fixture.scratch, 'gpg.log');
  const restoreInput = join(fixture.scratch, 'restore-input.sql');
  writeFileSync(replacement, 'attacker replacement bytes\n');
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_SOURCE_SHA: 'a'.repeat(40),
      DR_WAIT_SECONDS: '2',
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
      FAKE_DOCKER_STATE: bashPath(fixture.dockerState),
      FAKE_DOCKER_REPLACEMENT_STATE: bashPath(fixture.dockerReplacementState),
      FAKE_SWAP_ORIGINAL: bashPath(fixture.backupFile),
      FAKE_SWAP_REPLACEMENT: bashPath(replacement),
      FAKE_GPG_LOG: bashPath(gpgLog),
      FAKE_RESTORE_STDIN_LOG: bashPath(restoreInput),
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fixture.backupFile, 'utf8'), 'attacker replacement bytes\n');
    assert.match(readFileSync(gpgLog, 'utf8'), /lunchlineup-dr-backup\.[^/\r\n]+\/lunchlineup-.*\.sql\.zst\.gpg/);
    assert.notEqual(readFileSync(gpgLog, 'utf8').trim(), bashPath(fixture.backupFile));
    assert.equal(readFileSync(restoreInput, 'utf8'), readFileSync(fixture.remoteObject, 'utf8'));
    const proof = JSON.parse(readFileSync(fixture.proofFile, 'utf8'));
    assert.equal(proof.backup_sha256, fixture.expectedSha256);
    assert.doesNotMatch(JSON.stringify(proof), /attacker replacement bytes/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill verifies, executes, hashes, and parses only private snapshots after every adapter path is replaced', { skip: cgroupOwnerSkip }, () => {
  const fixture = createOffhostDrFixture();
  const replacements = {
    attestation: `${fixture.adapter.attestationFile}.replacement`,
    signature: `${fixture.adapter.signatureFile}.replacement`,
    fetch: `${fixture.fetchCommand}.replacement`,
    readback: `${fixture.readbackCommand}.replacement`,
    evidence: `${fixture.readbackFile}.replacement`,
  };
  writeFileSync(replacements.attestation, '{"corrupt":"attestation"}\n', { mode: 0o600 });
  writeFileSync(replacements.signature, '{"corrupt":"signature"}\n', { mode: 0o600 });
  writeExecutable(replacements.fetch, '#!/bin/sh\nexit 81\n');
  writeExecutable(replacements.readback, '#!/bin/sh\nexit 82\n');
  writeFileSync(replacements.evidence, '{"corrupt":"provider-readback"}\n', { mode: 0o600 });
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_SOURCE_SHA: 'a'.repeat(40),
      DR_WAIT_SECONDS: '2',
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
      FAKE_DOCKER_STATE: bashPath(fixture.dockerState),
      FAKE_DOCKER_REPLACEMENT_STATE: bashPath(fixture.dockerReplacementState),
      FAKE_ADAPTER_EXEC_LOG: bashPath(fixture.adapterExecLog),
      FAKE_SWAP_ATTESTATION_ORIGINAL: bashPath(fixture.adapter.attestationFile),
      FAKE_SWAP_ATTESTATION_REPLACEMENT: bashPath(replacements.attestation),
      FAKE_SWAP_SIGNATURE_ORIGINAL: bashPath(fixture.adapter.signatureFile),
      FAKE_SWAP_SIGNATURE_REPLACEMENT: bashPath(replacements.signature),
      FAKE_SWAP_FETCH_ORIGINAL: bashPath(fixture.fetchCommand),
      FAKE_SWAP_FETCH_REPLACEMENT: bashPath(replacements.fetch),
      FAKE_SWAP_READBACK_ORIGINAL: bashPath(fixture.readbackCommand),
      FAKE_SWAP_READBACK_REPLACEMENT: bashPath(replacements.readback),
      FAKE_SWAP_READBACK_EVIDENCE_ORIGINAL: bashPath(fixture.readbackFile),
      FAKE_SWAP_READBACK_EVIDENCE_REPLACEMENT: bashPath(replacements.evidence),
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const cosignPaths = readFileSync(fixture.cosignLog, 'utf8').trim();
    assert.match(cosignPaths, /lunchlineup-dr-evidence\.[^|/\r\n]+\/adapter-attestation\.json\|.*lunchlineup-dr-evidence\.[^/\r\n]+\/adapter-signature\.sigstore\.json/);
    assert.doesNotMatch(cosignPaths, new RegExp(bashPath(fixture.adapter.attestationFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const executions = readFileSync(fixture.adapterExecLog, 'utf8').trim().split(/\r?\n/);
    assert.equal(executions.length, 2);
    assert.match(executions[0], /^fetch\|.*lunchlineup-dr-evidence\.[^/\r\n]+\/fetch-adapter$/);
    assert.match(executions[1], /^readback\|.*lunchlineup-dr-evidence\.[^/\r\n]+\/readback-adapter$/);
    assert.match(readFileSync(fixture.adapter.attestationFile, 'utf8'), /corrupt/);
    assert.match(readFileSync(fixture.fetchCommand, 'utf8'), /exit 81/);
    assert.match(readFileSync(fixture.readbackFile, 'utf8'), /corrupt/);
    const proof = JSON.parse(readFileSync(fixture.proofFile, 'utf8'));
    assert.equal(proof.source_fetch_command_sha256, fixture.adapter.fetchSha256);
    assert.equal(proof.source_readback_command_sha256, fixture.adapter.readbackSha256);
    assert.equal(proof.source_adapter_attestation_sha256, fixture.adapter.attestationSha256);
    assert.equal(proof.source_adapter_signature_bundle_sha256, fixture.adapter.signatureSha256);
    const normalizedReadback = JSON.parse(Buffer.from(proof.source_readback_base64, 'base64').toString('utf8'));
    assert.equal(normalizedReadback.kind, 'lunchlineup-provider-authenticated-object-readback');
    assert.equal(normalizedReadback.resolvedVersion, fixture.sourceVersion);
    assert.doesNotMatch(JSON.stringify(proof), /corrupt|exit 81|exit 82/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR aggregate deadline exhaustion between readiness and restore removes the immutable container ID and publishes no proof', { skip: cgroupOwnerSkip }, () => {
  const fixture = createOffhostDrFixture();
  const readinessMarker = join(fixture.scratch, 'readiness-complete');
  const gpgLog = join(fixture.scratch, 'gpg.log');
  writeExecutable(join(fixture.fakeBin, 'date'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == '-u +%s' ]]; then
  if [[ -f "$FAKE_READINESS_MARKER" ]]; then printf '2000000002\\n'; else printf '2000000000\\n'; fi
  exit 0
fi
exec /usr/bin/date "$@"
`);
  writeFileSync(fixture.proofFile, JSON.stringify({ status: 'ok', stale: true }));
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
      DR_PROOF_FILE: bashPath(fixture.proofFile),
      DR_SOURCE_SHA: 'a'.repeat(40),
      DR_WAIT_SECONDS: '2',
      DR_DOCKER_OPERATION_TIMEOUT_SECONDS: '1',
      DR_DECRYPT_TIMEOUT_SECONDS: '1',
      DR_ZSTD_TIMEOUT_SECONDS: '1',
      DR_PSQL_TIMEOUT_SECONDS: '1',
      DR_CLEANUP_TIMEOUT_SECONDS: '1',
      DR_RESTORE_PIPELINE_TIMEOUT_SECONDS: '1',
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
      FAKE_DOCKER_STATE: bashPath(fixture.dockerState),
      FAKE_DOCKER_REPLACEMENT_STATE: bashPath(fixture.dockerReplacementState),
      FAKE_READINESS_MARKER: bashPath(readinessMarker),
      FAKE_GPG_LOG: bashPath(gpgLog),
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /deadline exhausted before Backup decryption/);
    assert.equal(existsSync(gpgLog), false, 'decryption started after the aggregate deadline');
    assert.equal(existsSync(fixture.dockerState), false, 'captured immutable container ID survived timeout cleanup');
    assert.equal(existsSync(fixture.proofFile), false, 'deadline failure left success evidence');
    assert.match(readFileSync(fixture.dockerLog, 'utf8'), new RegExp(`rm -f ${'d'.repeat(64)}`));
    assert.doesNotMatch(result.stdout, /DR drill successful|dr_drill_ok/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill makes docker cleanup and exact absence readback terminal before success proof', { skip: cgroupOwnerSkip }, () => {
  for (const [failureEnv, expected, containerRemains, replacementRemains] of [
    [{ FAKE_DOCKER_RM_FAIL: 'true' }, /container cleanup failed or timed out/, true],
    [{ FAKE_DOCKER_PS_FAIL_AFTER_RM: 'true' }, /Could not independently read back DR container (?:ID|name) absence/, false],
    [{ FAKE_DOCKER_REPLACE_BEFORE_CLEANUP: 'true' }, /rename or replacement race/, false, true],
  ]) {
    const fixture = createOffhostDrFixture();
    try {
      writeFileSync(fixture.proofFile, JSON.stringify({ status: 'ok', stale: true }));
      const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
        BACKUP_FILE: bashPath(fixture.backupFile),
        BACKUP_ENCRYPTION_KEY: 'test-key',
        DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
        DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
        DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
        DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
        DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
        ...fixture.adapterEnv,
        DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
        DR_PROOF_FILE: bashPath(fixture.proofFile),
        DR_SOURCE_SHA: 'a'.repeat(40),
        DR_WAIT_SECONDS: '2',
        FAKE_REMOTE_URI: fixture.sourceUri,
        FAKE_REMOTE_VERSION: fixture.sourceVersion,
        FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
        FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
        FAKE_DOCKER_STATE: bashPath(fixture.dockerState),
        FAKE_DOCKER_REPLACEMENT_STATE: bashPath(fixture.dockerReplacementState),
        ...failureEnv,
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
      assert.doesNotMatch(result.stdout, /DR drill successful|dr_drill_ok/);
      assert.equal(existsSync(fixture.proofFile), false, 'cleanup uncertainty left launch-acceptable success evidence');
      assert.equal(existsSync(fixture.dockerState), containerRemains);
      assert.equal(existsSync(fixture.dockerReplacementState), replacementRemains ?? false);
      if (replacementRemains) {
        assert.doesNotMatch(readFileSync(fixture.dockerLog, 'utf8'), new RegExp(`rm -f ${'e'.repeat(64)}`));
      }
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('DR drill rejects self-attested or provider-mismatched version and checksum readback', { skip: cgroupOwnerSkip }, () => {
  const cases = [
    [{ FAKE_READBACK_RESOLVED_VERSION: 'wrong-version' }, /Provider-authenticated readback does not independently bind/],
    [{ FAKE_READBACK_SHA256: 'f'.repeat(64) }, /Provider-authenticated readback does not independently bind/],
    [{ FAKE_READBACK_AUTH_STATUS: 'claimed' }, /Provider-authenticated readback does not independently bind/],
    [{ FAKE_READBACK_PRINCIPAL: '' }, /Provider-authenticated readback does not independently bind/],
    [{ FAKE_READBACK_REQUEST_ID: 'short' }, /Provider-authenticated readback does not independently bind/],
    [{ FAKE_READBACK_OBSERVED_AT: '2026-01-01T00:00:00Z' }, /Provider-authenticated readback does not independently bind/],
  ];
  for (const [override, expected] of cases) {
    const fixture = createOffhostDrFixture();
    try {
      const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
        BACKUP_FILE: bashPath(fixture.backupFile),
        BACKUP_ENCRYPTION_KEY: 'test-key',
        DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
        DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
        DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
        DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
        DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
        ...fixture.adapterEnv,
        DR_OFFHOST_READBACK_FILE: bashPath(fixture.readbackFile),
        FAKE_REMOTE_URI: fixture.sourceUri,
        FAKE_REMOTE_VERSION: fixture.sourceVersion,
        FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
        FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
        ...override,
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
      assert.equal(existsSync(fixture.dockerLog), false, 'restore must not start after provider readback rejection');
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('DR drill rejects arbitrary adapters and forged self-consistent adapter JSON before restore', { skip: bashSkip }, () => {
  for (const forgedAttestation of [false, true]) {
    const fixture = createOffhostDrFixture();
    try {
      writeExecutable(fixture.fetchCommand, `${readFileSync(fixture.fetchCommand, 'utf8')}\n# arbitrary replacement\n`);
      const env = {
        BACKUP_FILE: bashPath(fixture.backupFile),
        BACKUP_ENCRYPTION_KEY: 'test-key',
        DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
        DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
        DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
        DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
        DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
        ...fixture.adapterEnv,
        FAKE_REMOTE_URI: fixture.sourceUri,
        FAKE_REMOTE_VERSION: fixture.sourceVersion,
        FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
        FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
      };
      if (forgedAttestation) {
        const forged = JSON.parse(readFileSync(fixture.adapter.attestationFile, 'utf8'));
        forged.fetchAdapterSha256 = createHash('sha256').update(readFileSync(fixture.fetchCommand)).digest('hex');
        writeFileSync(fixture.adapter.attestationFile, JSON.stringify(forged));
        env.FAKE_COSIGN_FAIL = 'true';
      }
      const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', env);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        forgedAttestation ? /attestation signature is invalid/ : /does not pin these exact fetch\/readback adapter bytes/,
      );
      assert.equal(existsSync(fixture.dockerLog), false);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('DR drill fails closed when the declared remote URI does not exist', { skip: cgroupOwnerSkip }, () => {
  const fixture = createOffhostDrFixture();
  const missingName = 'lunchlineup-20260716000001.sql.zst.gpg';
  const missingBackup = join(dirname(fixture.backupFile), missingName);
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(missingBackup),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: `s3://lunchlineup-prod/db-backups/${missingName}`,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
      FAKE_REMOTE_URI: fixture.sourceUri,
      FAKE_REMOTE_VERSION: fixture.sourceVersion,
      FAKE_REMOTE_OBJECT: bashPath(fixture.remoteObject),
      FAKE_DOCKER_LOG: bashPath(fixture.dockerLog),
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /retrieval failed for the exact declared object\/version/);
    assert.equal(existsSync(missingBackup), false);
    assert.equal(existsSync(fixture.dockerLog), false, 'restore must not start after remote retrieval failure');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill refuses a caller-provided local file as off-host evidence', { skip: bashSkip }, () => {
  const fixture = createOffhostDrFixture();
  writeFileSync(fixture.backupFile, 'caller-provided local bytes\n');
  try {
    const result = runBashScriptWithBin(bash, fixture.fakeBin, 'scripts/dr-drill.sh', {
      BACKUP_FILE: bashPath(fixture.backupFile),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: fixture.sourceUri,
      DR_OFFHOST_SOURCE_VERSION: fixture.sourceVersion,
      DR_OFFHOST_EXPECTED_SHA256: fixture.expectedSha256,
      DR_OFFHOST_FETCH_COMMAND: bashPath(fixture.fetchCommand),
      DR_OFFHOST_READBACK_COMMAND: bashPath(fixture.readbackCommand),
      ...fixture.adapterEnv,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /caller-provided local file cannot satisfy DR evidence/);
    assert.equal(existsSync(fixture.dockerLog), false);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('backup rejects unsafe backup directories before pg_dump is required', { skip: bashSkip }, () => {
  const result = runBashScript(bash, 'scripts/backup.sh', {
    BACKUP_DIR: '/',
    BACKUP_ENCRYPTION_KEY: 'test-key',
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /BACKUP_DIR must be a dedicated backup directory/);
  assert.doesNotMatch(output, /Required command is missing: pg_dump/);
});

test('production backup rejects mutable rclone repositories before database access', { skip: bashSkip }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-mutable-backup-'));
  try {
    const result = runBashScript(bash, 'scripts/backup.sh', {
      BACKUP_DIR: bashPath(scratch),
      BACKUP_ENCRYPTION_KEY: 'test-key',
      BACKUP_OFFSITE_ENABLED: 'true',
      BACKUP_OFFSITE_URI: 'rclone:mutable/db-backups',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Mutable rclone repositories cannot satisfy immutable production logical-backup proof/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Required command is missing: pg_dump/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('provider-command owner kill-bounds TERM-ignoring providers and caps output and downloads', { skip: processTreeSkip }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-provider-owner-'));
  const hanging = join(scratch, 'hanging-provider');
  const oversizeOutput = join(scratch, 'oversize-output');
  const oversizeDownload = join(scratch, 'oversize-download');
  const failedMutation = join(scratch, 'failed-mutation');
  const download = join(scratch, 'download');
  const hangingParentPidFile = join(scratch, 'hanging-parent.pid');
  const hangingChildPidFile = join(scratch, 'hanging-child.pid');
  const ownerArgs = (operation, command, extra = []) => [
    join(root, 'scripts/backup.sh'), '--provider-command',
    '--operation', operation,
    '--timeout-seconds', '1',
    '--kill-after-seconds', '1',
    '--max-output-bytes', '1024',
    ...extra,
    '--', bashPath(command),
  ];
  try {
    writeExecutable(hanging, `#!/usr/bin/env bash
set -euo pipefail
setsid bash -c '
  trap "" TERM
  printf "%s\\n" "$$" > "${bashPath(hangingChildPidFile)}"
  sleep 3
  printf "delayed provider rewrite\\n" > "${bashPath(download)}"
  while :; do sleep 1; done
' &
child=$!
printf '%s\n' "$$" > '${bashPath(hangingParentPidFile)}'
trap "" TERM
wait "$child"
`);
    writeExecutable(oversizeOutput, `#!/usr/bin/env bash
head -c 4096 /dev/zero
`);
    writeExecutable(oversizeDownload, `#!/usr/bin/env bash
head -c 4096 /dev/zero > '${bashPath(download)}'
`);
    writeExecutable(failedMutation, `#!/usr/bin/env bash
exit 5
`);

    const started = Date.now();
    const timedOut = spawnSync(bash, ownerArgs('read', hanging), {
      cwd: root, encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL',
    });
    assert.notEqual(timedOut.status, 0);
    assert.equal(timedOut.error?.code, undefined, 'TERM-ignoring provider escaped the owner deadline');
    assert.ok(Date.now() - started < 7_000);
    assert.match(timedOut.stderr, /reason=timeout/);
    const hangingParentPid = readFileSync(hangingParentPidFile, 'utf8').trim();
    const hangingChildPid = readFileSync(hangingChildPidFile, 'utf8').trim();
    const processCheck = spawnSync(bash, [
      '-c', 'for pid in "$@"; do ! kill -0 "$pid" 2>/dev/null || exit 1; done',
      'provider-process-check', hangingParentPid, hangingChildPid,
    ], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
    assert.equal(processCheck.status, 0, `provider process survived: parent=${hangingParentPid} child=${hangingChildPid}`);
    rmSync(download, { force: true });
    const delayedRewriteWindow = spawnSync(bash, ['-c', 'sleep 2'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL',
    });
    assert.equal(delayedRewriteWindow.status, 0);
    assert.equal(existsSync(download), false, 'setsid provider descendant mutated the download after owner return');

    const outputResult = spawnSync(bash, ownerArgs('read', oversizeOutput), { cwd: root, encoding: 'utf8', timeout: 8_000 });
    assert.notEqual(outputResult.status, 0);
    assert.match(outputResult.stderr, /reason=output-cap/);

    const downloadResult = spawnSync(bash, ownerArgs('read', oversizeDownload, [
      '--download-path', bashPath(download), '--max-download-bytes', '1024',
    ]), { cwd: root, encoding: 'utf8', timeout: 8_000 });
    assert.notEqual(downloadResult.status, 0);
    assert.match(downloadResult.stderr, /reason=download-cap/);

    const mutationResult = spawnSync(bash, ownerArgs('mutation', failedMutation), { cwd: root, encoding: 'utf8', timeout: 8_000 });
    assert.equal(mutationResult.status, 70);
    assert.match(mutationResult.stderr, /mutation state is unknown/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects vague latest backup aliases before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture('latest.sql.zst.gpg');
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_REQUIRE_OFFHOST_SOURCE: 'false',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Refusing vague drill target/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('restore and DR reject aggregate mutation deadlines above 600 seconds before mutation', { skip: bashSkip }, () => {
  const restoreFixture = createBackupFixture();
  const drFixture = createBackupFixture();
  try {
    const restore = runBashScript(bash, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'disposable',
      RESTORE_CONFIRM: 'restore-lunchlineup',
      RESTORE_MUTATION_TIMEOUT_SECONDS: '601',
    }, [restoreFixture.backupFile]);
    assert.notEqual(restore.status, 0);
    assert.match(`${restore.stdout}\n${restore.stderr}`, /RESTORE_MUTATION_TIMEOUT_SECONDS must be between 1 and 600/);
    assert.doesNotMatch(`${restore.stdout}\n${restore.stderr}`, /Required command is missing: (?:psql|gpg|zstd)/);

    const drill = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: drFixture.backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_REQUIRE_OFFHOST_SOURCE: 'false',
      DR_RESTORE_PIPELINE_TIMEOUT_SECONDS: '601',
    });
    assert.notEqual(drill.status, 0);
    assert.match(`${drill.stdout}\n${drill.stderr}`, /DR_RESTORE_PIPELINE_TIMEOUT_SECONDS must be between 1 and 600/);
    assert.doesNotMatch(`${drill.stdout}\n${drill.stderr}`, /Required command is missing: docker/);
  } finally {
    rmSync(restoreFixture.scratch, { recursive: true, force: true });
    rmSync(drFixture.scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects unsafe container names before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_CONTAINER: 'postgres',
      DR_OFFHOST_SOURCE_URI: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_CONTAINER must start with lunchlineup-dr-drill-/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects unpinned images before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_IMAGE: 'postgres:16-alpine',
      DR_OFFHOST_SOURCE_URI: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_IMAGE must include an immutable @sha256 digest/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('restore requires checksum proof before psql is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture('lunchlineup-20260709000000.sql.zst.gpg', false);
  try {
    const result = runBashScript(bash, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'disposable',
      RESTORE_CONFIRM: 'restore-lunchlineup',
    }, [backupFile]);

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Checksum file is required by default/);
    assert.doesNotMatch(output, /Required command is missing: psql/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('restore and DR reject symbolic-link backup inputs before checksum or decryption', { skip: bashSkip }, (t) => {
  const fixture = createBackupFixture();
  const linkPath = join(fixture.scratch, 'lunchlineup-20260716010000.sql.zst.gpg');
  try {
    try {
      symlinkSync(fixture.nativeBackupFile, linkPath, 'file');
    } catch (error) {
      t.skip(`file symlinks are unavailable: ${error.code ?? error.message}`);
      return;
    }
    if (!lstatSync(linkPath).isSymbolicLink()) {
      t.skip('the platform did not create a real file symlink');
      return;
    }
    for (const [script, env] of [
      ['scripts/restore.sh', {
        BACKUP_ENCRYPTION_KEY: 'test-key',
        RESTORE_TARGET_ENV: 'disposable',
        RESTORE_CONFIRM: 'restore-lunchlineup',
      }],
      ['scripts/dr-drill.sh', {
        BACKUP_ENCRYPTION_KEY: 'test-key',
        BACKUP_FILE: bashPath(linkPath),
        DR_REQUIRE_OFFHOST_SOURCE: 'false',
      }],
    ]) {
      const args = script.endsWith('restore.sh') ? [bashPath(linkPath)] : [];
      const result = runBashScript(bash, script, env, args);
      assert.notEqual(result.status, 0, script);
      assert.match(`${result.stdout}\n${result.stderr}`, /non-symlink regular file/, script);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Required command is missing: (?:gpg|psql|docker)/, script);
    }
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('restore checksum and decrypt consume one private snapshot after the declared path is atomically replaced', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const replacement = join(fixture.scratch, 'replacement.sql.zst.gpg');
  const gpgLog = join(fixture.scratch, 'gpg.log');
  const restoreInput = join(fixture.scratch, 'restore-input.sql');
  mkdirSync(fakeBin);
  writeFileSync(replacement, 'attacker replacement bytes\n');
  writeExecutable(join(fakeBin, 'gpg'), `#!/usr/bin/env bash
set -euo pipefail
backup="\${@: -1}"
mv -f -- "$FAKE_SWAP_REPLACEMENT" "$FAKE_SWAP_ORIGINAL"
printf '%s\\n' "$backup" > "$FAKE_GPG_LOG"
cat -- "$backup"
`);
  writeExecutable(join(fakeBin, 'zstd'), `#!/usr/bin/env bash
set -euo pipefail
cat
`);
  writeExecutable(join(fakeBin, 'psql'), `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" -c "* ]]; then printf '0\\n'; exit 0; fi
cat > "$FAKE_RESTORE_STDIN_LOG"
exit 77
`);
  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'disposable',
      RESTORE_CONFIRM: 'restore-lunchlineup',
      APP_DB_USER: 'lunchlineup_app',
      APP_DB_PASSWORD: 'fixture-app-password',
      PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'fixture-admin-context',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:fixture@localhost:5432/lunchlineup',
      FAKE_SWAP_ORIGINAL: fixture.backupFile,
      FAKE_SWAP_REPLACEMENT: bashPath(replacement),
      FAKE_GPG_LOG: bashPath(gpgLog),
      FAKE_RESTORE_STDIN_LOG: bashPath(restoreInput),
    }, [fixture.backupFile]);

    assert.notEqual(result.status, 0, 'fixture psql intentionally aborts after capturing restore bytes');
    assert.match(`${result.stdout}\n${result.stderr}`, /destructive restore transaction failed/);
    assert.equal(readFileSync(fixture.nativeBackupFile, 'utf8'), 'attacker replacement bytes\n');
    assert.match(readFileSync(gpgLog, 'utf8'), /lunchlineup-restore-evidence\.[^/\r\n]+\/backup\/lunchlineup-.*\.sql\.zst\.gpg/);
    assert.notEqual(readFileSync(gpgLog, 'utf8').trim(), fixture.backupFile);
    assert.equal(readFileSync(restoreInput, 'utf8'), 'encrypted fixture placeholder\n');
    assert.doesNotMatch(readFileSync(restoreInput, 'utf8'), /attacker replacement bytes/);
    assert.doesNotMatch(result.stdout, /restore_ok/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore requires digest-pinned provider-authenticated immutable provenance before database access', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const proofPath = join(fixture.scratch, 'provider-readback.json');
  const fakeBin = join(fixture.scratch, 'bin');
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), `#!/usr/bin/env bash
[[ "\${FAKE_COSIGN_FAIL:-false}" != "true" ]]
`);
  const adapter = createSignedAdapterFixture(fixture.scratch, 'c'.repeat(64), 'd'.repeat(64));
  const target = createProductionTargetFixture(fixture.scratch);
  const baseEnv = {
    BACKUP_ENCRYPTION_KEY: 'test-key',
    RESTORE_TARGET_ENV: 'production',
    RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
    ...target.env,
    RESTORE_DR_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
    RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
    RESTORE_DR_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
    RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
    RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
    RESTORE_DR_ADAPTER_OIDC_ISSUER: adapter.issuer,
  };
  try {
    const missing = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', baseEnv, [fixture.backupFile]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /RESTORE_DR_PROVENANCE_FILE/);
    assert.doesNotMatch(`${missing.stdout}\n${missing.stderr}`, /Required command is missing: psql/);

    const valid = productionRestoreProvenance(fixture.nativeBackupFile, adapter);
    const validBytes = Buffer.from(JSON.stringify(valid.proof));
    const validSha256 = createHash('sha256').update(validBytes).digest('hex');
    const execution = productionRestoreExecution(fixture.scratch, valid, validSha256);
    const cases = [
      {
        name: 'provider version mismatch',
        proof: { ...valid.proof, resolvedVersion: 'wrong-version' },
        digestOverride: undefined,
        expected: /missing, mismatched, unauthenticated, or stale/,
      },
      {
        name: 'provider byte mismatch',
        proof: { ...valid.proof, bytes: valid.proof.bytes + 1 },
        digestOverride: undefined,
        expected: /missing, mismatched, unauthenticated, or stale/,
      },
      {
        name: 'missing authenticated principal',
        proof: { ...valid.proof, authentication: { ...valid.proof.authentication, principal: '' } },
        digestOverride: undefined,
        expected: /missing, mismatched, unauthenticated, or stale/,
      },
      {
        name: 'missing provider request ID',
        proof: { ...valid.proof, authentication: { ...valid.proof.authentication, requestId: '' } },
        digestOverride: undefined,
        expected: /missing, mismatched, unauthenticated, or stale/,
      },
      {
        name: 'stale provider observation',
        proof: { ...valid.proof, observedAt: '2026-01-01T00:00:00.000Z' },
        digestOverride: undefined,
        expected: /missing, mismatched, unauthenticated, or stale/,
      },
      {
        name: 'readback digest mismatch',
        proof: valid.proof,
        digestOverride: '0'.repeat(64),
        expected: /readback digest does not match/,
      },
    ];
    for (const item of cases) {
      const proofBytes = Buffer.from(JSON.stringify(item.proof));
      writeFileSync(proofPath, proofBytes);
      const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
        ...baseEnv,
        ...execution.env,
        RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
        RESTORE_DR_PROVENANCE_SHA256: item.digestOverride ?? createHash('sha256').update(proofBytes).digest('hex'),
        RESTORE_DR_SOURCE_URI: valid.sourceUri,
        RESTORE_DR_SOURCE_VERSION: valid.sourceVersion,
      }, [fixture.backupFile]);
      assert.notEqual(result.status, 0, item.name);
      assert.match(`${result.stdout}\n${result.stderr}`, item.expected, item.name);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Required command is missing: psql/, item.name);
    }

    writeFileSync(proofPath, validBytes);
    const missingExecution = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      ...baseEnv,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: validSha256,
      RESTORE_DR_SOURCE_URI: valid.sourceUri,
      RESTORE_DR_SOURCE_VERSION: valid.sourceVersion,
    }, [fixture.backupFile]);
    assert.notEqual(missingExecution.status, 0);
    assert.match(`${missingExecution.stdout}\n${missingExecution.stderr}`, /DR execution attestation .*must be an absolute path/);

    const accepted = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      ...baseEnv,
      ...execution.env,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: validSha256,
      RESTORE_DR_SOURCE_URI: valid.sourceUri,
      RESTORE_DR_SOURCE_VERSION: valid.sourceVersion,
    }, [fixture.backupFile]);
    assert.notEqual(accepted.status, 0);
    assert.match(`${accepted.stdout}\n${accepted.stderr}`, /APP_DB_USER must be a simple Postgres identifier/);
    assert.doesNotMatch(`${accepted.stdout}\n${accepted.stderr}`, /provider provenance/i);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore binds every protected target and migration URL identity before database access', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), '#!/bin/sh\nexit 0\n');
  const cases = [
    ['cluster', { clusterId: 'other-cluster' }],
    ['postgres host', { postgres: { host: 'other-db.internal', port: 5432, database: 'lunchlineup', ownerUsername: 'postgres', systemIdentifier: productionSystemIdentifier } }],
    ['postgres port', { postgres: { host: 'prod-db.internal', port: 5433, database: 'lunchlineup', ownerUsername: 'postgres', systemIdentifier: productionSystemIdentifier } }],
    ['postgres database', { postgres: { host: 'prod-db.internal', port: 5432, database: 'other', ownerUsername: 'postgres', systemIdentifier: productionSystemIdentifier } }],
    ['postgres owner', { postgres: { host: 'prod-db.internal', port: 5432, database: 'lunchlineup', ownerUsername: 'other', systemIdentifier: productionSystemIdentifier } }],
    ['postgres system identifier', { postgres: { host: 'prod-db.internal', port: 5432, database: 'lunchlineup', ownerUsername: 'postgres', systemIdentifier: '9123456789012345678' } }],
    ['migration host', { migration: { host: 'other-db.internal', port: 5432, database: 'lunchlineup', username: 'postgres' } }],
    ['migration port', { migration: { host: 'prod-db.internal', port: 5433, database: 'lunchlineup', username: 'postgres' } }],
    ['migration database', { migration: { host: 'prod-db.internal', port: 5432, database: 'other', username: 'postgres' } }],
    ['migration username', { migration: { host: 'prod-db.internal', port: 5432, database: 'lunchlineup', username: 'other' } }],
  ];
  try {
    for (const [name, overrides] of cases) {
      const target = createProductionTargetFixture(fixture.scratch, overrides);
      const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
        BACKUP_ENCRYPTION_KEY: 'test-key',
        RESTORE_TARGET_ENV: 'production',
        RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
        ...target.env,
      }, [fixture.backupFile]);
      assert.notEqual(result.status, 0, name);
      assert.match(`${result.stdout}\n${result.stderr}`, /Protected production target descriptor does not match/, name);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Required command is missing: psql/, name);
    }

    const target = createProductionTargetFixture(fixture.scratch);
    const wrongConfirmation = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      ...target.env,
      RESTORE_CONFIRM: 'restore-production-target:wrong',
    }, [fixture.backupFile]);
    assert.notEqual(wrongConfirmation.status, 0);
    assert.match(`${wrongConfirmation.stdout}\n${wrongConfirmation.stderr}`, /Set RESTORE_CONFIRM=restore-production-target:/);
    assert.doesNotMatch(`${wrongConfirmation.stdout}\n${wrongConfirmation.stderr}`, /Required command is missing: psql/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore keeps the migration URL password marker out of child process argv', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const argvLog = join(fixture.scratch, 'node-argv.log');
  const passwordMarker = 'MIGRATION-ARGV-MARKER-7f4f9d';
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'node'), `#!/bin/sh
if [ -r /proc/$$/cmdline ]; then
  tr '\\000' ' ' </proc/$$/cmdline >>'${bashPath(argvLog)}'
  printf '\\n' >>'${bashPath(argvLog)}'
else
  printf '%s\\n' "$*" >>'${bashPath(argvLog)}'
fi
exec "\${REAL_NODE:?}" "$@"
`);
  const target = createProductionTargetFixture(fixture.scratch);
  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      ...target.env,
      MIGRATION_DATABASE_URL: `postgresql://postgres:${passwordMarker}@prod-db.internal:5432/lunchlineup`,
      REAL_NODE: bashPath(process.execPath),
    }, [fixture.backupFile]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /RESTORE_DR_PROVENANCE_FILE/);
    const childArgv = readFileSync(argvLog, 'utf8');
    assert.doesNotMatch(childArgv, new RegExp(passwordMarker));
    assert.doesNotMatch(childArgv, /postgresql:\/\/postgres:/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore consumes only private snapshots when every signed evidence path is atomically replaced after Cosign starts', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const proofPath = join(fixture.scratch, 'provider-readback.json');
  const cosignCount = join(fixture.scratch, 'cosign-count');
  const cosignLog = join(fixture.scratch, 'cosign.log');
  mkdirSync(fakeBin);
  const adapter = createSignedAdapterFixture(fixture.scratch, 'c'.repeat(64), 'd'.repeat(64));
  const target = createProductionTargetFixture(fixture.scratch);
  const provenance = productionRestoreProvenance(fixture.nativeBackupFile, adapter);
  const proofBytes = Buffer.from(JSON.stringify(provenance.proof));
  const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
  writeFileSync(proofPath, proofBytes, { mode: 0o600 });
  const execution = productionRestoreExecution(fixture.scratch, provenance, proofSha256);
  const groups = [
    [target.descriptorFile, target.env.RESTORE_PRODUCTION_TARGET_PIN_FILE, target.env.RESTORE_PRODUCTION_TARGET_PIN_SIGNATURE_BUNDLE_FILE],
    [proofPath, adapter.attestationFile, adapter.signatureFile],
    [
      execution.env.RESTORE_DR_EXECUTION_ATTESTATION_FILE,
      execution.env.RESTORE_DR_EXECUTION_SIGNATURE_BUNDLE_FILE,
    ],
  ];
  const swapEnv = {};
  groups.forEach((paths, groupIndex) => paths.forEach((path, pathIndex) => {
    const nativePath = process.platform === 'win32'
      ? path.replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replaceAll('/', '\\')
      : path;
    const replacement = `${nativePath}.replacement-${groupIndex}-${pathIndex}`;
    writeFileSync(replacement, `{"corrupt":"replacement-${groupIndex}-${pathIndex}"}\n`, { mode: 0o600 });
    swapEnv[`SWAP_${groupIndex}_${pathIndex}_ORIGINAL`] = bashPath(nativePath);
    swapEnv[`SWAP_${groupIndex}_${pathIndex}_REPLACEMENT`] = bashPath(replacement);
  }));
  writeExecutable(join(fakeBin, 'cosign'), `#!/usr/bin/env bash
set -euo pipefail
payload="$2"
bundle="$4"
[[ "$payload" == *lunchlineup-restore-evidence* && "$bundle" == *lunchlineup-restore-evidence* ]]
[[ "$(stat -c '%a' -- "$payload")" == 600 && "$(stat -c '%a' -- "$bundle")" == 600 ]]
count=0
[[ ! -f "$COSIGN_COUNT_FILE" ]] || count="$(<"$COSIGN_COUNT_FILE")"
count=$((count + 1))
printf '%s' "$count" > "$COSIGN_COUNT_FILE"
printf 'verified-private-snapshot-%s\n' "$count" >> "$COSIGN_SAFE_LOG"
group=$((count - 1))
for index in 0 1 2; do
  original_name="SWAP_\${group}_\${index}_ORIGINAL"
  replacement_name="SWAP_\${group}_\${index}_REPLACEMENT"
  [[ -n "\${!original_name:-}" ]] || continue
  mv -f -- "\${!replacement_name}" "\${!original_name}"
done
`);

  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      ...target.env,
      RESTORE_DR_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
      RESTORE_DR_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
      RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
      RESTORE_DR_ADAPTER_OIDC_ISSUER: adapter.issuer,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: proofSha256,
      RESTORE_DR_SOURCE_URI: provenance.sourceUri,
      RESTORE_DR_SOURCE_VERSION: provenance.sourceVersion,
      ...execution.env,
      COSIGN_COUNT_FILE: bashPath(cosignCount),
      COSIGN_SAFE_LOG: bashPath(cosignLog),
      ...swapEnv,
    }, [fixture.backupFile]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /APP_DB_USER must be a simple Postgres identifier/);
    assert.equal(readFileSync(cosignCount, 'utf8'), '3');
    assert.equal(readFileSync(cosignLog, 'utf8').trim().split(/\r?\n/).length, 3);
    assert.match(readFileSync(target.descriptorFile, 'utf8'), /replacement-0-0/);
    assert.match(readFileSync(proofPath, 'utf8'), /replacement-1-0/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore aggregate mutation timeout exits 70, kills children, and performs bounded identity/readback reconciliation', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const proofPath = join(fixture.scratch, 'provider-readback.json');
  const psqlLog = join(fixture.scratch, 'psql.log');
  const childPidFile = join(fixture.scratch, 'mutation-child.pid');
  const mutationStartedAtFile = join(fixture.scratch, 'mutation-started-at');
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'gpg'), '#!/bin/sh\nprintf "%s\\n" "CREATE TABLE aggregate_deadline_fixture(id integer);"\n');
  writeExecutable(join(fakeBin, 'zstd'), '#!/bin/sh\ncat\n');
  writeExecutable(join(fakeBin, 'psql'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>'${bashPath(psqlLog)}'
case " $* " in
  *'SELECT system_identifier::text FROM pg_control_system();'*) printf '%s\n' '${productionSystemIdentifier}'; exit 0 ;;
  *'SELECT count(*) FROM information_schema.tables'*) printf '0\n'; exit 0 ;;
esac
cat >/dev/null
date +%s >'${bashPath(mutationStartedAtFile)}'
sleep "\${FAKE_MUTATION_SLEEP_SECONDS:-45}" &
child=$!
printf '%s' "$child" >'${bashPath(childPidFile)}'
wait "$child"
`);
  const adapter = createSignedAdapterFixture(fixture.scratch, 'c'.repeat(64), 'd'.repeat(64));
  const target = createProductionTargetFixture(fixture.scratch);
  const provenance = productionRestoreProvenance(fixture.nativeBackupFile, adapter);
  const proofBytes = Buffer.from(JSON.stringify(provenance.proof));
  const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
  writeFileSync(proofPath, proofBytes, { mode: 0o600 });
  const execution = productionRestoreExecution(fixture.scratch, provenance, proofSha256);

  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      APP_DB_USER: 'lunchlineup_app',
      APP_DB_PASSWORD: 'app-password',
      PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'platform-admin-context',
      ...target.env,
      RESTORE_DR_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
      RESTORE_DR_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
      RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
      RESTORE_DR_ADAPTER_OIDC_ISSUER: adapter.issuer,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: proofSha256,
      RESTORE_DR_SOURCE_URI: provenance.sourceUri,
      RESTORE_DR_SOURCE_VERSION: provenance.sourceVersion,
      ...execution.env,
      RESTORE_MUTATION_TIMEOUT_SECONDS: '3',
      RESTORE_RECONCILIATION_TIMEOUT_SECONDS: '5',
      FAKE_MUTATION_SLEEP_SECONDS: '45',
    }, [fixture.backupFile]);
    const mutationStartedAt = Number(readFileSync(mutationStartedAtFile, 'utf8').trim()) * 1_000;
    assert.ok(Date.now() - mutationStartedAt < 20_000, 'aggregate timeout must not wait for a surviving mutation child');
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /mutation state is unknown and must not be retried blindly/);
    assert.match(result.stderr, /restore_unknown_state_reconciliation target_identity=match table_readback=count:0/);
    const calls = readFileSync(psqlLog, 'utf8');
    assert.ok((calls.match(/pg_control_system/g) ?? []).length >= 2, 'reconciliation must re-read target identity');
    assert.ok((calls.match(/information_schema\.tables/g) ?? []).length >= 2, 'reconciliation must re-read target tables');
    const childPid = readFileSync(childPidFile, 'utf8').trim();
    const alive = spawnSync(bash, ['-c', 'kill -0 "$1" 2>/dev/null', 'child-check', childPid]);
    assert.notEqual(alive.status, 0, `mutation child ${childPid} survived the aggregate timeout`);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore queries PostgreSQL system_identifier and rejects a mismatch before mutation', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const psqlLog = join(fixture.scratch, 'psql.log');
  const mutationLog = join(fixture.scratch, 'mutation.log');
  const proofPath = join(fixture.scratch, 'provider-readback.json');
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'gpg'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'zstd'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'psql'), `#!/bin/sh
printf '%s\n' "$*" >>'${bashPath(psqlLog)}'
case " $* " in
  *'pg_control_system()'*) printf '%s\n' '9999999999999999999'; exit 0 ;;
esac
printf '%s\n' mutation >'${bashPath(mutationLog)}'
exit 0
`);
  const adapter = createSignedAdapterFixture(fixture.scratch, 'c'.repeat(64), 'd'.repeat(64));
  const target = createProductionTargetFixture(fixture.scratch);
  const provenance = productionRestoreProvenance(fixture.nativeBackupFile, adapter);
  const proofBytes = Buffer.from(JSON.stringify(provenance.proof));
  const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
  writeFileSync(proofPath, proofBytes);
  const execution = productionRestoreExecution(fixture.scratch, provenance, proofSha256);
  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      APP_DB_USER: 'lunchlineup_app',
      APP_DB_PASSWORD: 'app-password',
      PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'platform-admin-context',
      ...target.env,
      RESTORE_DR_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
      RESTORE_DR_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
      RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
      RESTORE_DR_ADAPTER_OIDC_ISSUER: adapter.issuer,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: proofSha256,
      RESTORE_DR_SOURCE_URI: provenance.sourceUri,
      RESTORE_DR_SOURCE_VERSION: provenance.sourceVersion,
      ...execution.env,
    }, [fixture.backupFile]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /system identifier does not match the independently signed production target pin/);
    const psqlCalls = readFileSync(psqlLog, 'utf8').trim().split(/\r?\n/);
    assert.equal(psqlCalls.length, 1);
    assert.match(psqlCalls[0], /SELECT system_identifier::text FROM pg_control_system\(\)/);
    assert.equal(existsSync(mutationLog), false, 'database mutation was attempted before system identifier verification');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('production restore reasserts the pinned system_identifier inside the destructive transaction after an endpoint switch', { skip: bashSkip }, () => {
  const fixture = createBackupFixture();
  const fakeBin = join(fixture.scratch, 'bin');
  const psqlLog = join(fixture.scratch, 'psql.log');
  const transactionSql = join(fixture.scratch, 'restore-transaction.sql');
  const unsafeMutation = join(fixture.scratch, 'unsafe-mutation.log');
  const proofPath = join(fixture.scratch, 'provider-readback.json');
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'cosign'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'gpg'), '#!/bin/sh\nprintf "%s\\n" "CREATE TABLE endpoint_switch_fixture(id integer);"\n');
  writeExecutable(join(fakeBin, 'zstd'), '#!/bin/sh\ncat\n');
  writeExecutable(join(fakeBin, 'psql'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >>'${bashPath(psqlLog)}'
case " $* " in
  *' SELECT system_identifier::text FROM pg_control_system(); '*)
    printf '%s\n' '${productionSystemIdentifier}'
    exit 0
    ;;
  *' SELECT count(*) FROM information_schema.tables '*)
    printf '%s\n' '1'
    exit 0
    ;;
esac
cat >'${bashPath(transactionSql)}'
identity_line="$(grep -n 'pg_control_system()' '${bashPath(transactionSql)}' | head -n 1 | cut -d: -f1)"
drop_line="$(grep -n 'DROP SCHEMA public CASCADE' '${bashPath(transactionSql)}' | head -n 1 | cut -d: -f1)"
if [ -z "$identity_line" ] || [ -z "$drop_line" ] || [ "$identity_line" -ge "$drop_line" ]; then
  printf '%s\n' mutation-without-transactional-identity >'${bashPath(unsafeMutation)}'
  exit 0
fi
echo 'ERROR: endpoint switched to a different system_identifier; transaction rejected before DROP' >&2
exit 1
`);
  const adapter = createSignedAdapterFixture(fixture.scratch, 'c'.repeat(64), 'd'.repeat(64));
  const target = createProductionTargetFixture(fixture.scratch);
  const provenance = productionRestoreProvenance(fixture.nativeBackupFile, adapter);
  const proofBytes = Buffer.from(JSON.stringify(provenance.proof));
  const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
  writeFileSync(proofPath, proofBytes);
  const execution = productionRestoreExecution(fixture.scratch, provenance, proofSha256);
  try {
    const result = runBashScriptWithBin(bash, fakeBin, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'production',
      RESTORE_ALLOW_PRODUCTION: 'YES_RESTORE_PRODUCTION',
      RESTORE_ALLOW_NONEMPTY: 'YES_OVERWRITE',
      APP_DB_USER: 'lunchlineup_app',
      APP_DB_PASSWORD: 'app-password',
      PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'platform-admin-context',
      ...target.env,
      RESTORE_DR_ADAPTER_ATTESTATION_FILE: bashPath(adapter.attestationFile),
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_FILE: bashPath(adapter.signatureFile),
      RESTORE_DR_ADAPTER_ATTESTATION_URI: adapter.attestationUri,
      RESTORE_DR_ADAPTER_SIGNATURE_BUNDLE_URI: adapter.signatureUri,
      RESTORE_DR_ADAPTER_CERTIFICATE_IDENTITY: adapter.identity,
      RESTORE_DR_ADAPTER_OIDC_ISSUER: adapter.issuer,
      RESTORE_DR_PROVENANCE_FILE: bashPath(proofPath),
      RESTORE_DR_PROVENANCE_SHA256: proofSha256,
      RESTORE_DR_SOURCE_URI: provenance.sourceUri,
      RESTORE_DR_SOURCE_VERSION: provenance.sourceVersion,
      ...execution.env,
    }, [fixture.backupFile]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /endpoint switched to a different system_identifier/);
    const sql = readFileSync(transactionSql, 'utf8');
    const identityAssertion = sql.indexOf('SELECT system_identifier::text INTO observed_system_identifier FROM pg_control_system()');
    const destructiveDrop = sql.indexOf('DROP SCHEMA public CASCADE');
    const backupImport = sql.indexOf('CREATE TABLE endpoint_switch_fixture');
    assert.ok(identityAssertion >= 0 && identityAssertion < destructiveDrop && identityAssertion < backupImport);
    assert.match(sql, new RegExp(productionSystemIdentifier));
    assert.equal(existsSync(unsafeMutation), false);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('restore forces an atomic rollback when decryption or decompression fails', () => {
  const backup = read('scripts/backup.sh');
  const restore = read('scripts/restore.sh');

  assert.match(backup, /pg_dump[\s\S]*--clean[\s\S]*--if-exists/);
  assert.match(restore, /if ! gpg[\s\S]*\| zstd -d -c; then/);
  assert.match(restore, /RAISE EXCEPTION 'backup stream validation failed'/);
  assert.match(restore, /--single-transaction/);
  assert.ok(
    restore.indexOf("SELECT system_identifier::text INTO observed_system_identifier FROM pg_control_system()")
      < restore.indexOf("'DROP SCHEMA public CASCADE;'"),
  );
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.match(restore, new RegExp(`has_table_privilege\\(current_user, relation\\.oid, '${privilege}'\\)`));
  }
});
