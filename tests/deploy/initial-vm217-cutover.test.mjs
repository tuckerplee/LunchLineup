import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cutoverScript = join(root, 'scripts', 'initial-vm217-cutover.sh');
const proofVerifier = join(root, 'scripts', 'verify-initial-cutover-proof.mjs');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const durableProofUri = `s3://lunchlineup-production-recovery/vm217/initial-cutover/${sourceSha}.json`;
const launchProofUri = `https://proofs.lunchlineup.com/releases/${sourceSha}/launch-proof.json`;

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bashPathFor(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
}

function proof(overrides = {}) {
  const { snapshot: snapshotOverrides = {}, ...proofOverrides } = overrides;
  return {
    version: 1,
    kind: 'lunchlineup-initial-vm217-cutover-rollback',
    status: 'ready',
    vmId: 217,
    legacySystem: 'php',
    host: 'vm217.example',
    targetSourceSha: sourceSha,
    snapshot: {
      reference: 'proxmox:vm217:snapshot:legacy-php-cutover',
      createdAt: '2026-07-13T12:00:00Z',
      durableProofUri,
      snapshotCommandSha256: 'a'.repeat(64),
      proofFetchCommandSha256: 'c'.repeat(64),
      rollbackCommandSha256: 'b'.repeat(64),
      ...snapshotOverrides,
    },
    ...proofOverrides,
  };
}

function runProofVerifier(proofValue) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-initial-cutover-proof-'));
  const proofPath = join(scratch, 'proof.json');
  writeFileSync(proofPath, JSON.stringify(proofValue));
  const result = spawnSync(process.execPath, [
    proofVerifier,
    '--proof-file', proofPath,
    '--expected-host', 'vm217.example',
    '--expected-source-sha', sourceSha,
    '--expected-proof-uri', durableProofUri,
    '--expected-snapshot-command-sha256', 'a'.repeat(64),
    '--expected-proof-fetch-command-sha256', 'c'.repeat(64),
    '--expected-rollback-command-sha256', 'b'.repeat(64),
    '--max-age-seconds', '300',
    '--verification-time', '2026-07-13T12:04:00Z',
  ], { cwd: root, encoding: 'utf8' });
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

function createFixture({ deployFails = false, deployHangs = false, snapshotHangs = false, fetchHangs = false, rollbackHangs = false, proofAlreadyExists = false, existingV2Marker = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-initial-vm217-cutover-'));
  const fakeBin = join(scratch, 'bin');
  const commands = join(scratch, 'external-commands');
  const files = {
    privateKey: join(scratch, 'id_ed25519'),
    knownHosts: join(scratch, 'known_hosts'),
    manifest: join(scratch, 'release-manifest.json'),
    runtimeEnv: join(scratch, 'runtime.env'),
    launchProof: join(scratch, 'launch-proof.json'),
    rollbackProof: join(scratch, 'rollback-proof.json'),
    recoveryLog: join(scratch, 'recovery.log'),
    transportLog: join(scratch, 'transport.log'),
    snapshotCommand: join(commands, 'snapshot'),
    proofFetchCommand: join(commands, 'fetch-proof'),
    rollbackCommand: join(commands, 'rollback'),
  };

  mkdirSync(fakeBin);
  mkdirSync(commands);
  writeFileSync(files.privateKey, 'fixture-private-key\n');
  writeFileSync(files.knownHosts, 'vm217.example ssh-ed25519 AAAAfixture\n');
  writeFileSync(files.manifest, `{"sourceSha":"${sourceSha}"}\n`);
  writeFileSync(files.runtimeEnv, 'FIXTURE_VALUE=not-a-secret\n');
  writeFileSync(files.launchProof, '{"status":"passed"}\n');
  if (proofAlreadyExists) writeFileSync(files.rollbackProof, '{"stale":true}\n');

  writeExecutable(files.snapshotCommand, `#!/usr/bin/env bash
set -euo pipefail
printf 'snapshot\\n' >> "$FAKE_RECOVERY_LOG"
[[ "\${FAKE_SNAPSHOT_HANG:-false}" != "true" ]] || exec sleep 10
`);
  writeExecutable(files.proofFetchCommand, `#!/usr/bin/env bash
set -euo pipefail
printf 'proof-fetch\\n' >> "$FAKE_RECOVERY_LOG"
[[ "\${FAKE_FETCH_HANG:-false}" != "true" ]] || exec sleep 10
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$INITIAL_CUTOVER_PROOF_FILE" <<JSON
{"version":1,"kind":"lunchlineup-initial-vm217-cutover-rollback","status":"ready","vmId":217,"legacySystem":"php","host":"$INITIAL_CUTOVER_HOST","targetSourceSha":"$INITIAL_CUTOVER_SOURCE_SHA","snapshot":{"reference":"proxmox:vm217:snapshot:legacy-php-cutover","createdAt":"$created_at","durableProofUri":"$INITIAL_CUTOVER_DURABLE_PROOF_URI","snapshotCommandSha256":"$INITIAL_CUTOVER_SNAPSHOT_COMMAND_SHA256","proofFetchCommandSha256":"$INITIAL_CUTOVER_PROOF_FETCH_COMMAND_SHA256","rollbackCommandSha256":"$INITIAL_CUTOVER_ROLLBACK_COMMAND_SHA256"}}
JSON
chmod 600 "$INITIAL_CUTOVER_PROOF_FILE"
`);
  writeExecutable(files.rollbackCommand, `#!/usr/bin/env bash
set -euo pipefail
printf 'rollback:%s:%s\\n' "$INITIAL_CUTOVER_FAILURE_REASON" "$INITIAL_CUTOVER_DEPLOY_EXIT_CODE" >> "$FAKE_RECOVERY_LOG"
[[ "\${FAKE_ROLLBACK_HANG:-false}" != "true" ]] || exec sleep 10
`);

  writeExecutable(join(fakeBin, 'stat'), `#!/usr/bin/env bash
path="\${@: -1}"
case "$path" in
  *id_ed25519|*runtime.env|*rollback-proof.json) printf '600\\n' ;;
  *external-commands/*) printf '700\\n' ;;
  *) printf '644\\n' ;;
esac
`);
  writeExecutable(join(fakeBin, 'ssh-keygen'), `#!/usr/bin/env bash
if [[ "\${1:-}" == "-F" ]]; then
  printf 'vm217.example ssh-ed25519 AAAAfixture\\n'
fi
exit 0
`);
  writeExecutable(join(fakeBin, 'scp'), `#!/usr/bin/env bash
printf 'scp\\n' >> "$FAKE_TRANSPORT_LOG"
`);
  writeExecutable(join(fakeBin, 'ssh'), `#!/usr/bin/env bash
printf 'ssh' >> "$FAKE_TRANSPORT_LOG"
remote_script=false
initial_preflight=false
has_stdin_script=false
for arg in "$@"; do
  printf ' <%s>' "$arg" >> "$FAKE_TRANSPORT_LOG"
  [[ "$arg" == */deploy-vm217-remote.sh ]] && remote_script=true
  [[ "$arg" == "initial-vm217-cutover-preflight" ]] && initial_preflight=true
  [[ "$arg" == "-s" ]] && has_stdin_script=true
done
printf '\\n' >> "$FAKE_TRANSPORT_LOG"

previous=""
for arg in "$@"; do
  if [[ "$previous" == "mktemp" && "$arg" == "-d" ]]; then
    printf '/tmp/lunchlineup-ci-transport.FIXTURE01\\n'
    exit 0
  fi
  if [[ "$previous" == "sha256sum" && "$arg" == "--" ]]; then
    previous="sha256sum--"
    continue
  fi
  if [[ "$previous" == "sha256sum--" ]]; then
    case "$arg" in
      */release-manifest.json) printf '%s  %s\\n' "$FAKE_MANIFEST_SHA" "$arg" ;;
      */runtime.env) printf '%s  %s\\n' "$FAKE_RUNTIME_SHA" "$arg" ;;
      */launch-proof.json) printf '%s  %s\\n' "$FAKE_LAUNCH_PROOF_SHA" "$arg" ;;
      */protected-channel) printf '%s  %s\\n' "$FAKE_PROTECTED_CHANNEL_SHA" "$arg" ;;
      */deploy-vm217-remote.sh) printf '%s  %s\\n' "$FAKE_ENTRYPOINT_SHA" "$arg" ;;
      *) exit 91 ;;
    esac
    exit 0
  fi
  previous="$arg"
done

if [[ "$initial_preflight" == "true" && "\${FAKE_EXISTING_V2_MARKER:-false}" == "true" ]]; then
  exit 42
fi

if [[ "$remote_script" == "true" && "\${FAKE_DEPLOY_FAIL:-false}" == "true" ]]; then
  exit 42
fi
if [[ "$remote_script" == "true" && "\${FAKE_DEPLOY_HANG:-false}" == "true" ]]; then
  exec sleep 10
fi
if [[ "$has_stdin_script" == "true" && "$remote_script" != "true" && "$initial_preflight" != "true" ]]; then
  expected_primary=""
  for arg in "$@"; do
    [[ "$arg" == "legacy" || "$arg" == "${sourceSha}" ]] && { expected_primary="$arg"; break; }
  done
  if [[ "$expected_primary" == "legacy" ]]; then
    state="\${FAKE_LEGACY_RECONCILE_STATE:-primary}"
    primary_release="legacy"
    secondary_release="${sourceSha}"
    legacy_traffic=true
  else
    state="\${FAKE_CANDIDATE_RECONCILE_STATE:-primary}"
    primary_release="${sourceSha}"
    secondary_release="legacy"
    legacy_traffic=false
  fi
  case "$state" in
    primary) printf 'vm217_reconciliation_ok exact_state=primary active_release_sha=%s service_release_sha=%s traffic_release_sha=%s legacy_traffic=%s\n' "$primary_release" "$primary_release" "$primary_release" "$legacy_traffic" ;;
    secondary) printf 'vm217_reconciliation_ok exact_state=secondary active_release_sha=%s service_release_sha=%s traffic_release_sha=%s legacy_traffic=true\n' "$secondary_release" "$secondary_release" "$secondary_release" ;;
    *) exit 93 ;;
  esac
fi
`);

  return { scratch, fakeBin, files, deployFails, deployHangs, snapshotHangs, fetchHangs, rollbackHangs, existingV2Marker };
}

function runFixture(fixture, overrides = {}) {
  const env = {
    ...process.env,
    FAKE_RECOVERY_LOG: bashPathFor(fixture.files.recoveryLog),
    FAKE_TRANSPORT_LOG: bashPathFor(fixture.files.transportLog),
    FAKE_MANIFEST_SHA: digest(readFileSync(fixture.files.manifest)),
    FAKE_RUNTIME_SHA: digest(readFileSync(fixture.files.runtimeEnv)),
    FAKE_LAUNCH_PROOF_SHA: digest(readFileSync(fixture.files.launchProof)),
    FAKE_ENTRYPOINT_SHA: digest(readFileSync(join(root, 'scripts', 'deploy-vm217-remote.sh'))),
    FAKE_PROTECTED_CHANNEL_SHA: digest(`${launchProofUri}\n`),
    LAUNCH_PROOF_MANIFEST_URI: launchProofUri,
    PRODUCTION_WEB_URL: 'https://lunchlineup.example/',
    FAKE_DEPLOY_FAIL: String(fixture.deployFails),
    FAKE_DEPLOY_HANG: String(fixture.deployHangs),
    FAKE_SNAPSHOT_HANG: String(fixture.snapshotHangs),
    FAKE_FETCH_HANG: String(fixture.fetchHangs),
    FAKE_ROLLBACK_HANG: String(fixture.rollbackHangs),
    FAKE_EXISTING_V2_MARKER: String(fixture.existingV2Marker),
    VM217_SSH_COMMAND_TIMEOUT_SECONDS: fixture.deployHangs ? '1' : '1800',
    VM217_TRANSPORT_KILL_AFTER_SECONDS: fixture.deployHangs ? '1' : '5',
    INITIAL_CUTOVER_SNAPSHOT_TIMEOUT_SECONDS: fixture.snapshotHangs ? '1' : '300',
    INITIAL_CUTOVER_PROOF_FETCH_TIMEOUT_SECONDS: fixture.fetchHangs ? '1' : '120',
    INITIAL_CUTOVER_ROLLBACK_TIMEOUT_SECONDS: fixture.rollbackHangs ? '1' : '600',
    INITIAL_CUTOVER_ADAPTER_KILL_AFTER_SECONDS: '1',
    ...overrides,
  };
  const args = [
    '-c',
    'PATH="$1:$PATH"; export PATH; shift; exec bash "$@"',
    'initial-cutover-fixture',
    bashPathFor(fixture.fakeBin),
    bashPathFor(cutoverScript),
    '--host', 'vm217.example',
    '--user', 'deploy',
    '--private-key', bashPathFor(fixture.files.privateKey),
    '--known-hosts', bashPathFor(fixture.files.knownHosts),
    '--release-manifest', bashPathFor(fixture.files.manifest),
    '--runtime-env', bashPathFor(fixture.files.runtimeEnv),
    '--launch-proof', bashPathFor(fixture.files.launchProof),
    '--source-sha', sourceSha,
    '--snapshot-command', bashPathFor(fixture.files.snapshotCommand),
    '--proof-fetch-command', bashPathFor(fixture.files.proofFetchCommand),
    '--rollback-command', bashPathFor(fixture.files.rollbackCommand),
    '--rollback-proof', bashPathFor(fixture.files.rollbackProof),
    '--durable-proof-uri', fixture.durableProofUri ?? durableProofUri,
    '--confirm', `initial-vm217-cutover-from-legacy-php:${sourceSha}`,
  ];
  return spawnSync(bashPath, args, { cwd: root, encoding: 'utf8', env });
}

test('initial cutover tooling is isolated, digest-bound, and delegates to pinned transport', () => {
  const script = read('scripts/initial-vm217-cutover.sh');
  const verifier = read('scripts/verify-initial-cutover-proof.mjs');

  assert.match(script, /set -euo pipefail/);
  assert.match(script, /deploy-vm217-transport\.sh/);
  assert.match(script, /verify-initial-cutover-proof\.mjs/);
  assert.match(script, /ssh-keygen -F "\$HOST" -f "\$KNOWN_HOSTS"/);
  assert.match(script, /INITIAL_CUTOVER_SSH_STRICT_HOST_KEY_CHECKING=yes/);
  assert.match(script, /PasswordAuthentication=no/);
  assert.match(script, /ConnectTimeout=\$VM217_SSH_CONNECT_TIMEOUT_SECONDS/);
  assert.match(script, /ServerAliveInterval=\$VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS/);
  assert.match(script, /External snapshot command/);
  assert.match(script, /External rollback command/);
  assert.match(script, /External durable proof fetch/);
  assert.match(script, /INITIAL_CUTOVER_SNAPSHOT_TIMEOUT_SECONDS/);
  assert.match(script, /INITIAL_CUTOVER_PROOF_FETCH_TIMEOUT_SECONDS/);
  assert.match(script, /INITIAL_CUTOVER_ROLLBACK_TIMEOUT_SECONDS/);
  assert.match(script, /adapter state is unknown and requires independent readback reconciliation/);
  assert.match(script, /reconcile_initial_cutover_state legacy -/);
  assert.match(script, /reconcile_initial_cutover_state "\$SOURCE_SHA" legacy/);
  assert.match(script, /VM217_RECONCILIATION_ALLOW_LEGACY=true/);
  assert.match(script, /current_pointer="\$2\/current"/);
  assert.doesNotMatch(script, /accept-new|release-bundle-registry|\beval\b|\bbash\s+-c\b/);
  assert.match(verifier, /lunchlineup-initial-vm217-cutover-rollback/);
  assert.match(verifier, /proof snapshot is stale/);
});

test('durable rollback proof validator accepts exact fresh proof and rejects stale or tampered proof', () => {
  const valid = runProofVerifier(proof());
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.match(valid.stdout, /initial_cutover_rollback_proof_ok/);

  const stale = runProofVerifier(proof({ snapshot: { createdAt: '2026-07-13T11:54:59Z' } }));
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /proof snapshot is stale/);

  const wrongFetch = runProofVerifier(proof({ snapshot: { proofFetchCommandSha256: 'd'.repeat(64) } }));
  assert.notEqual(wrongFetch.status, 0);
  assert.match(wrongFetch.stderr, /proof fetch command digest/);

  const wrongRollback = runProofVerifier(proof({ snapshot: { rollbackCommandSha256: 'c'.repeat(64) } }));
  assert.notEqual(wrongRollback.status, 0);
  assert.match(wrongRollback.stderr, /rollback command digest/);

  const localProof = runProofVerifier(proof({ snapshot: { durableProofUri: 'file:///tmp/proof.json' } }));
  assert.notEqual(localProof.status, 0);
  assert.match(localProof.stderr, /does not match the requested retained object/);
});

test('initial cutover fixture arms durable rollback before pinned VM217 transport', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /initial_cutover_rollback_proof_ok/);
    assert.match(result.stdout, /vm217_transport_ok/);
    assert.match(result.stdout, /initial_vm217_cutover_ok/);
    assert.equal(readFileSync(fixture.files.recoveryLog, 'utf8'), 'snapshot\nproof-fetch\n');

    const transportLog = readFileSync(fixture.files.transportLog, 'utf8');
    assert.match(transportLog, /StrictHostKeyChecking=yes/);
    assert.match(transportLog, /UserKnownHostsFile=/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${transportLog}`, /FIXTURE_VALUE=not-a-secret|fixture-private-key/);
    assert.doesNotMatch(transportLog, new RegExp(`${launchProofUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${Buffer.from(launchProofUri).toString('base64')}`));
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('failed delegated deploy invokes the attested external rollback and remains failed', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ deployFails: true });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /initial_vm217_cutover_external_rollback_ok/);
    assert.equal(
      readFileSync(fixture.files.recoveryLog, 'utf8'),
      'snapshot\nproof-fetch\nrollback:deploy-transport-failed:42\n',
    );
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out delegated deploy preserves rollback eligibility by invoking the attested rollback', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ deployHangs: true });
  try {
    const startedAt = Date.now();
    const result = runFixture(fixture);
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /remote state is unknown\. Keep rollback eligibility armed/);
    assert.match(result.stderr, /initial_vm217_cutover_external_rollback_ok/);
    assert.match(result.stdout, /exact_state=primary active_release_sha=legacy/);
    assert.equal(
      readFileSync(fixture.files.recoveryLog, 'utf8'),
      'snapshot\nproof-fetch\nrollback:deploy-transport-failed:124\n',
    );
    assert.ok(Date.now() - startedAt < 16000, 'cutover transport, rollback, and reconciliation must remain bounded');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('successful no-op delegated deploy is rolled back and exits 70', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, { FAKE_CANDIDATE_RECONCILE_STATE: 'secondary' });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /secondary or another non-target state/);
    assert.equal(
      readFileSync(fixture.files.recoveryLog, 'utf8'),
      'snapshot\nproof-fetch\nrollback:deploy-success-reconciliation-failed:0\n',
    );
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('external rollback no-op success exits 70 when full legacy reconciliation fails', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ deployFails: true });
  try {
    const result = runFixture(fixture, { FAKE_LEGACY_RECONCILE_STATE: 'unknown' });
    assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /reported success but exact legacy state was not active/);
    assert.equal(
      readFileSync(fixture.files.recoveryLog, 'utf8'),
      'snapshot\nproof-fetch\nrollback:deploy-transport-failed:42\n',
    );
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out snapshot is reconciled by independently bounded durable proof fetch', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ snapshotHangs: true });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /External snapshot command timed out/);
    assert.match(result.stderr, /initial_cutover_snapshot_unknown_state_reconciled/);
    assert.equal(readFileSync(fixture.files.recoveryLog, 'utf8'), 'snapshot\nproof-fetch\n');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out durable proof fetch retries once and blocks mutation while state remains unknown', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ fetchHangs: true });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remained unknown after one bounded retry/);
    assert.equal(readFileSync(fixture.files.recoveryLog, 'utf8'), 'snapshot\nproof-fetch\nproof-fetch\n');
    assert.doesNotMatch(readFileSync(fixture.files.transportLog, 'utf8'), /deploy-vm217-remote\.sh/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out external rollback uses independent pinned-host state reconciliation', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ deployFails: true, rollbackHangs: true });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /External rollback command timed out/);
    assert.match(result.stderr, /initial_vm217_cutover_external_rollback_reconciled/);
    assert.match(
      readFileSync(fixture.files.transportLog, 'utf8'),
      /<legacy> <-> <-> <-> <\/var\/lib\/lunchlineup\/runtime-env\/current> <\/var\/lib\/lunchlineup\/backup-release\.env> <lunchlineup>/,
    );
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('pre-existing runner proof blocks before snapshot or transport', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ proofAlreadyExists: true });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist before the durable proof is fetched/);
    assert.equal(existsSync(fixture.files.recoveryLog), false);
    assert.equal(existsSync(fixture.files.transportLog), false);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('malformed durable proof URI blocks before snapshot or transport', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  fixture.durableProofUri = 'https:///missing-host/proof.json';
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must identify a specific retained https:\/\/ or s3:\/\/ object/);
    assert.equal(existsSync(fixture.files.recoveryLog), false);
    assert.equal(existsSync(fixture.files.transportLog), false);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('existing v2 deployment marker blocks the one-time path before snapshot', { skip: !bashAvailable }, () => {
  const fixture = createFixture({ existingV2Marker: true });
  try {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no existing DEPLOYED_GIT_SHA/);
    assert.equal(existsSync(fixture.files.recoveryLog), false);
    assert.match(readFileSync(fixture.files.transportLog, 'utf8'), /initial-vm217-cutover-preflight/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});
test('initial cutover docs keep later release-registry deploys strict', () => {
  assert.match(read('scripts/README.md'), /`initial-vm217-cutover\.sh`/);
  assert.match(read('scripts/README.md'), /`verify-initial-cutover-proof\.mjs`/);
  assert.match(read('tests/deploy/README.md'), /`initial-vm217-cutover\.test\.mjs`/);
  const runbook = read('docs/runbooks/production-readiness.md');
  assert.match(runbook, /Legacy PHP Initial VM217 Cutover/);
  assert.match(runbook, /does not seed, relax, or bypass the retained release registry/i);
  assert.match(runbook, /StrictHostKeyChecking=yes/);
});
