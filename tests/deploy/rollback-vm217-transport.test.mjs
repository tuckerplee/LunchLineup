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
const scriptPath = join(root, 'scripts', 'rollback-vm217-transport.sh');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;
const fixturePlatformStartupMarginMs = process.platform === 'win32' ? 30_000 : 0;
const deterministicDeadlineCeilingMs = 18_000;
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const candidateSha = 'b'.repeat(40);
const certificateIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const oidcIssuer = 'https://token.actions.githubusercontent.com';
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
  chmodSync(path, 0o755);
}

function createFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-rollback-transport-'));
  const fakeBin = join(scratch, 'bin');
  const rollbackApp = join(scratch, 'rollback-app');
  const scriptsDir = join(rollbackApp, 'scripts');
  const releaseDir = join(rollbackApp, '.release');
  const files = {
    privateKey: join(scratch, 'id_ed25519'),
    knownHosts: join(scratch, 'known_hosts'),
    runtimeEnv: join(scratch, 'runtime.env'),
    descriptor: join(scratch, 'runtime-secret.json'),
    launchProof: join(scratch, 'launch-proof.json'),
    manifest: join(releaseDir, 'release-manifest.json'),
    entrypoint: join(scriptsDir, 'deploy-vm217-remote.sh'),
    verifier: join(scriptsDir, 'verify-release-artifacts.mjs'),
    compatibilityVerifier: join(scriptsDir, 'verify-old-release-compatibility.mjs'),
    compatibilityProof: join(scratch, 'old-release-compatibility.json'),
    compatibilitySignature: join(scratch, 'old-release-compatibility.sigstore.json'),
    transportPid: join(scratch, 'transport.pid'),
    log: join(scratch, 'transport.log'),
  };

  mkdirSync(fakeBin);
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(releaseDir);
  writeFileSync(files.privateKey, 'fixture-private-key\n');
  writeFileSync(files.knownHosts, 'vm217.example ssh-ed25519 AAAAfixture\n');
  writeFileSync(files.runtimeEnv, 'FIXTURE_SECRET=do-not-log-this-value\n');
  writeFileSync(files.launchProof, JSON.stringify({ sourceSha, status: 'passed' }));
  writeFileSync(files.entrypoint, '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(files.verifier, 'process.exit(0);\n');
  writeFileSync(files.compatibilityVerifier, readFileSync(join(root, 'scripts', 'verify-old-release-compatibility.mjs')));
  writeFileSync(files.compatibilityProof, `${JSON.stringify({
    version: 1,
    status: 'passed',
    previousReleaseSha: sourceSha,
    candidateReleaseSha: candidateSha,
    database: { isolatedClone: true, productionMutated: false },
    candidateSchema: { applied: true },
    oldReleaseSmoke: { status: 'passed' },
    completedAt: new Date().toISOString(),
    evidenceUri: 's3://proofs/old-release-compatibility.json',
  })}\n`);
  writeFileSync(files.compatibilitySignature, `${digest(readFileSync(files.compatibilityProof))}\n`);

  const runtimeSha = digest(readFileSync(files.runtimeEnv));
  writeFileSync(files.descriptor, `${JSON.stringify({
    version: 1,
    provider: 'aws-secretsmanager',
    reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup-prod',
    secretVersion: 'a'.repeat(32),
    sha256: runtimeSha,
  })}\n`);
  writeFileSync(files.manifest, `${JSON.stringify({
    sourceSha,
    deploymentContract: {
      files: {
        'scripts/deploy-vm217-remote.sh': digest(readFileSync(files.entrypoint)),
        'scripts/verify-release-artifacts.mjs': digest(readFileSync(files.verifier)),
      },
    },
  })}\n`);

  writeExecutable(join(fakeBin, 'stat'), `#!/usr/bin/env bash
path="\${@: -1}"
case "$path" in
  *rollback-app) printf '700\\n' ;;
  *id_ed25519|*runtime.env|*runtime-secret.json) printf '600\\n' ;;
  *) printf '644\\n' ;;
esac
`);
  writeExecutable(join(fakeBin, 'ssh-keygen'), `#!/usr/bin/env bash
if [[ " $* " == *" -F "* && "\${FAKE_KNOWN_HOSTS_MATCH:-true}" != "true" ]]; then
  exit 1
fi
if [[ " $* " == *" -F "* ]]; then
  printf '# Host vm217.example found: line 1\\nvm217.example ssh-ed25519 AAAAfixture\\n'
fi
exit 0
`);
  writeExecutable(join(fakeBin, 'scp'), `#!/usr/bin/env bash
printf 'scp' >> "$FAKE_TRANSPORT_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$FAKE_TRANSPORT_LOG"; done
printf '\\n' >> "$FAKE_TRANSPORT_LOG"
`);
  writeExecutable(join(fakeBin, 'cosign'), `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "verify-blob" ]] || exit 2
artifact="$2"
shift 2
bundle=""
while (( $# > 0 )); do
  if [[ "$1" == "--bundle" ]]; then bundle="$2"; shift 2; else shift; fi
done
[[ -n "$bundle" ]] || exit 2
[[ "$(tr -d '\\r\\n' < "$bundle")" == "$(sha256sum -- "$artifact" | awk '{print tolower($1)}')" ]]
`);
  writeExecutable(join(fakeBin, 'ssh'), `#!/usr/bin/env bash
printf 'ssh' >> "$FAKE_TRANSPORT_LOG"
remote_activation=false
has_activator=false
has_stdin_script=false
for arg in "$@"; do printf ' <%s>' "$arg" >> "$FAKE_TRANSPORT_LOG"; done
for arg in "$@"; do
  [[ "$arg" == */activate-retained-rollback.sh ]] && has_activator=true
  [[ "$arg" == "-s" ]] && has_stdin_script=true
done
[[ "$has_activator" == "true" && "$has_stdin_script" == "true" ]] && remote_activation=true
printf '\\n' >> "$FAKE_TRANSPORT_LOG"

previous=""
for arg in "$@"; do
  if [[ "$previous" == "mktemp" && "$arg" == "-d" ]]; then
    printf '/tmp/lunchlineup-rollback-transport.FIXTURE01\\n'
    exit 0
  fi
  previous="$arg"
done

if [[ "$remote_activation" == "true" && "\${FAKE_REMOTE_FAIL:-false}" == "true" ]]; then
  printf 'failure-point <%s>\n' "\${FAKE_REMOTE_FAIL_POINT:-unspecified}" >> "$FAKE_TRANSPORT_LOG"
  exit 86
fi
if [[ "$remote_activation" == "true" && "\${FAKE_REMOTE_HANG:-false}" == "true" ]]; then
  printf 'activation-hanging\n' >> "$FAKE_TRANSPORT_LOG"
  if [[ "\${FAKE_REMOTE_SIGNAL_TERM:-false}" == "true" ]]; then
    transport_pid="$(tr -d '\r\n' < "$FAKE_TRANSPORT_PID_FILE")"
    [[ "$transport_pid" =~ ^[1-9][0-9]*$ ]] || exit 97
    (sleep 1; kill -TERM "$transport_pid") &
  fi
  exec sleep "\${FAKE_REMOTE_HANG_SECONDS:-10}"
fi
if [[ "$has_stdin_script" == "true" && "$remote_activation" != "true" ]]; then
  printf 'reconciliation-start <%s>\n' "\${FAKE_RECONCILE_STATE:-unknown}" >> "$FAKE_TRANSPORT_LOG"
  case "\${FAKE_RECONCILE_STATE:-unknown}" in
    primary)
      printf 'vm217_reconciliation_ok exact_state=primary active_release_sha=${sourceSha} service_release_sha=${sourceSha} traffic_release_sha=${sourceSha} legacy_traffic=false\\n'
      ;;
    secondary)
      printf 'vm217_reconciliation_ok exact_state=secondary active_release_sha=${candidateSha} service_release_sha=${candidateSha} traffic_release_sha=${candidateSha} legacy_traffic=false\\n'
      ;;
    *) exit 93 ;;
  esac
fi
`);

  return { scratch, fakeBin, rollbackApp, files };
}

function fixtureArgs(fixture) {
  return [
    '--host', 'vm217.example',
    '--user', 'deploy',
    '--private-key', bashPathFor(fixture.files.privateKey),
    '--known-hosts', bashPathFor(fixture.files.knownHosts),
    '--rollback-app-dir', bashPathFor(fixture.rollbackApp),
    '--release-manifest', bashPathFor(fixture.files.manifest),
    '--runtime-env', bashPathFor(fixture.files.runtimeEnv),
    '--runtime-secret-descriptor', bashPathFor(fixture.files.descriptor),
    '--launch-proof', bashPathFor(fixture.files.launchProof),
    '--source-sha', sourceSha,
    '--old-release-compatibility-proof', bashPathFor(fixture.files.compatibilityProof),
    '--old-release-compatibility-signature-bundle', bashPathFor(fixture.files.compatibilitySignature),
    '--old-release-compatibility-proof-sha256', digest(readFileSync(fixture.files.compatibilityProof)),
    '--compatibility-candidate-source-sha', candidateSha,
    '--expected-certificate-identity', certificateIdentity,
    '--expected-oidc-issuer', oidcIssuer,
  ];
}

function runFixture(fixture, overrides = {}, explicitArgs = fixtureArgs(fixture)) {
  const env = {
    ...process.env,
    FAKE_TRANSPORT_LOG: bashPathFor(fixture.files.log),
    FAKE_TRANSPORT_PID_FILE: bashPathFor(fixture.files.transportPid),
    PRODUCTION_API_HEALTH_URL: 'https://api.lunchlineup.com/health',
    PRODUCTION_WEB_URL: 'https://lunchlineup.com/',
    LAUNCH_PROOF_MANIFEST_URI: launchProofUri,
    FAKE_RECONCILE_STATE: 'primary',
    ...overrides,
  };
  const args = [
    '-c',
    'PATH="$1:$PATH"; printf \'%s\\n\' "$BASHPID" > "$2"; export PATH; shift 2; exec bash "$@"',
    'rollback-transport-fixture',
    bashPathFor(fixture.fakeBin),
    bashPathFor(fixture.files.transportPid),
    bashPathFor(scriptPath),
    ...explicitArgs,
  ];
  return spawnSync(bashPath, args, {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 30_000 + fixturePlatformStartupMarginMs,
  });
}

test('manual VM217 rollback transport is pinned, exact, isolated, and fail closed', () => {
  const script = read('scripts/rollback-vm217-transport.sh');

  assert.match(script, /set -euo pipefail/);
  assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /UserKnownHostsFile=\$KNOWN_HOSTS/);
  assert.match(script, /PasswordAuthentication=no/);
  assert.match(script, /ConnectTimeout=\$VM217_SSH_CONNECT_TIMEOUT_SECONDS/);
  assert.match(script, /ServerAliveCountMax=\$VM217_SSH_SERVER_ALIVE_COUNT_MAX/);
  assert.match(script, /vm217_begin_mutation_budget[\s\S]*remote rollback staging allocation/);
  assert.match(script, /ssh-keygen -F "\$HOST" -f "\$KNOWN_HOSTS"/);
  assert.match(script, /ssh-keygen -y -P '' -f "\$PRIVATE_KEY"/);
  assert.match(script, /git -C "\$REPO_ROOT" ls-files --error-unmatch/);
  assert.match(script, /Rehydrated runtime environment does not match the retained runtime-secret descriptor/);
  assert.match(script, /Retained remote rollback entrypoint does not match the release manifest/);
  assert.match(script, /tar --create --file "\$LOCAL_ARCHIVE"/);
  assert.match(script, /ACTIVATOR="\$SCRIPT_DIR\/activate-retained-rollback\.sh"/);
  assert.match(script, /ACTIVATOR_SHA256="\$\(sha256_file "\$ACTIVATOR"\)"/);
  assert.match(script, /vm217_run_scp "rollback activator upload" "\$\{SCP_OPTIONS\[@\]\}" -- "\$ACTIVATOR" "\$SCP_TARGET:\$REMOTE_ACTIVATOR"/);
  assert.match(script, /"\$VERIFIER_SHA256"[\s\S]*"\$OLD_RELEASE_COMPATIBILITY_PROOF_SHA256"[\s\S]*"\$RETENTION_COUNT" <<'REMOTE_SCRIPT'/);
  assert.match(script, /cosign verify-blob "\$OLD_RELEASE_COMPATIBILITY_PROOF"/);
  assert.match(script, /actual_sha256="\$\(sha256sum -- "\$activator"/);
  assert.match(script, /exec bash "\$activator" "\$@"/);
  assert.doesNotMatch(script, /live_pointer_tmp/);
  assert.match(script, /trap cleanup_staging EXIT/);
  assert.match(script, /rm -rf -- "\$REMOTE_STAGE"/);
  assert.match(script, /rm -f -- "\$LOCAL_ARCHIVE"/);
  assert.doesNotMatch(script, /\beval\b|\$\{?SHELL\}?|\bbash\s+-c\b|\bsh\s+-c\b/);

  const deadlines = read('scripts/vm217-transport-deadlines.sh');
  assert.match(deadlines, /VM217_MUTATION_BUDGET_SECONDS="\$\{VM217_MUTATION_BUDGET_SECONDS:-\$VM217_SSH_COMMAND_TIMEOUT_SECONDS\}"/);
  assert.match(deadlines, /VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS/);
  assert.match(deadlines, /effective_deadline_seconds="\$remaining_seconds"/);
  assert.match(deadlines, /vm217_run_with_mutation_budget "\$operation" "\$VM217_SSH_COMMAND_TIMEOUT_SECONDS" ssh/);
  assert.match(deadlines, /vm217_run_with_mutation_budget "\$operation" "\$VM217_SCP_COMMAND_TIMEOUT_SECONDS" scp/);
});

test('TERM during hanging activation reconciles exact target before cleanup without trap recursion', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, {
      FAKE_REMOTE_HANG: 'true',
      FAKE_REMOTE_HANG_SECONDS: '3',
      FAKE_REMOTE_SIGNAL_TERM: 'true',
      FAKE_RECONCILE_STATE: 'primary',
      VM217_SSH_COMMAND_TIMEOUT_SECONDS: '30',
      VM217_MUTATION_BUDGET_SECONDS: '60',
      VM217_SSH_RECONCILE_TIMEOUT_SECONDS: '5',
      VM217_SSH_CLEANUP_TIMEOUT_SECONDS: '5',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /vm217_rollback_transport_recovered .*signal=TERM state=exact-committed-state/);
    assert.match(result.stderr, /attempting one bounded authenticated reconciliation before cleanup/);

    const log = readFileSync(fixture.files.log, 'utf8');
    const activation = log.indexOf('activation-hanging');
    const reconciliation = log.indexOf('reconciliation-start <primary>');
    const cleanup = log.indexOf('rm> <-rf> <--> </tmp/lunchlineup-rollback-transport.FIXTURE01>');
    assert.ok(activation >= 0 && reconciliation > activation, 'TERM must reconcile after activation starts');
    assert.ok(cleanup > reconciliation, 'authenticated reconciliation must precede staging cleanup');
    assert.equal((result.stderr.match(/attempting one bounded authenticated reconciliation/g) || []).length, 1);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('expired pre-mutation cutoff refuses every remote operation', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, { VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS: '1' });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /pre-mutation cutoff passed before remote mutation began/);
    assert.equal(existsSync(fixture.files.log), false, 'cutoff refusal must happen before SSH or SCP');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('rollback activator materializes immutable retained bytes and commits pointers before pruning', () => {
  const activator = read('scripts/activate-retained-rollback.sh');

  assert.match(activator, /flock -n 9/);
  assert.match(activator, /rollback_app="\$release_root\/\$source_sha"/);
  assert.match(activator, /mv -T -- "\$incoming_release" "\$rollback_app"/);
  assert.match(activator, /find "\$release" -type d[\s\S]*chmod 550/);
  assert.match(activator, /find "\$release" -type f ! -perm \/0111[\s\S]*chmod 440/);
  assert.match(activator, /find "\$release" -type f -perm \/0111[\s\S]*chmod 550/);
  assert.match(activator, /normalize_managed_directory "\$release_root" "Durable release root"/);
  assert.match(activator, /validate_release_identity "\$rollback_app"/);
  assert.match(activator, /candidate_deployment_root="\$release_root\/\$compatibility_candidate_source_sha"/);
  assert.match(activator, /failed candidate retained release manifest does not match the compatibility proof SHA/i);
  assert.match(activator, /ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT=\$candidate_deployment_root/);
  assert.match(activator, /ACTIVE_RELEASE_POINTER=\$active_pointer/);
  assert.match(activator, /LUNCHLINEUP_SERVICE_GROUP=\$SERVICE_GROUP_NAME/);
  assert.match(activator, /Active release identity marker is stale after rollback/);
  assert.match(activator, /restore_active_pointer/);
  assert.match(activator, /finalize_postcommit_pointer_bookkeeping/);
  assert.match(activator, /pointer_targets "\$active_pointer" "\$rollback_app"[\s\S]*post_rollback_pointer_commit_checkpoint active/);
  assert.match(activator, /mv -Tf -- "\$previous_pointer_tmp" "\$previous_pointer"[\s\S]*post_rollback_pointer_commit_checkpoint previous/);
  assert.match(activator, /full_reconciliation=required/);
  assert.doesNotMatch(activator, /vm217_rollback_remote_postcommit_recovered/);
  assert.ok(
    activator.lastIndexOf('activation_committed=true') > activator.lastIndexOf('pointer_targets "$previous_pointer" "$previous_target"'),
    'activation cannot be committed before the previous pointer is exact',
  );
  const activated = activator.indexOf('pointer_targets "\$active_pointer" "\$rollback_app"');
  const pruned = activator.indexOf('prune_inactive_releases "\$rollback_app" "\$previous_target"');
  assert.ok(activated >= 0 && pruned > activated, 'retention pruning must follow successful atomic activation');
});

test('fixture stages retained rollback bytes, invokes the retained entrypoint, and cleans both sides without network', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`vm217_rollback_transport_ok sha=${sourceSha}`));

    const log = readFileSync(fixture.files.log, 'utf8');
    assert.equal((log.match(/^scp/gm) ?? []).length, 8);
    assert.match(log, /StrictHostKeyChecking=yes/);
    assert.match(log, /UserKnownHostsFile=/);
    assert.match(log, /ConnectTimeout=15/);
    assert.match(log, /ServerAliveCountMax=3/);
    assert.match(log, /<bash> <-s> <-->/);
    assert.match(log, /<scripts\/deploy-vm217-remote\.sh>/);
    assert.match(log, /activate-retained-rollback\.sh>/);
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-rollback-transport\.FIXTURE01>/);
    assert.doesNotMatch(log, /do-not-log-this-value|fixture-private-key/);
    assert.doesNotMatch(log, new RegExp(`${launchProofUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${Buffer.from(launchProofUri).toString('base64')}`));
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out retained rollback activation exits with fixed unknown-state guidance and bounded cleanup', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const startedAt = Date.now();
    const result = runFixture(fixture, {
      FAKE_REMOTE_HANG: 'true',
      FAKE_RECONCILE_STATE: 'unknown',
      VM217_SSH_COMMAND_TIMEOUT_SECONDS: '1',
      VM217_MUTATION_BUDGET_SECONDS: '15',
      VM217_SSH_CLEANUP_TIMEOUT_SECONDS: '1',
      VM217_TRANSPORT_KILL_AFTER_SECONDS: '1',
    });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /remote state is unknown\. Keep rollback eligibility armed/);
    const deterministicElapsedMs = Date.now() - startedAt - fixturePlatformStartupMarginMs;
    assert.ok(
      deterministicElapsedMs < deterministicDeadlineCeilingMs,
      'rollback transport, reconciliation, and cleanup must respect their deadlines after the explicit platform startup margin',
    );
    const log = readFileSync(fixture.files.log, 'utf8');
    assert.ok((log.match(/<bash> <-s> <-->/g) ?? []).length >= 2, 'rollback timeout must trigger read-only reconciliation');
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-rollback-transport\.FIXTURE01>/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('failure after previous pointer commit reconciles exact committed state and returns recovered success', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, {
      FAKE_REMOTE_FAIL: 'true',
      FAKE_REMOTE_FAIL_POINT: 'previous',
      FAKE_RECONCILE_STATE: 'primary',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`vm217_rollback_transport_recovered sha=${sourceSha} activation_exit_code=86 state=exact-committed-state`));
    const log = readFileSync(fixture.files.log, 'utf8');
    assert.match(log, /failure-point <previous>/);
    assert.ok((log.match(/<bash> <-s> <-->/g) ?? []).length >= 2, 'every activation failure must reconcile');
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-rollback-transport\.FIXTURE01>/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('timed-out rollback activation can recover only when exact target is independently active', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, {
      FAKE_REMOTE_HANG: 'true',
      FAKE_RECONCILE_STATE: 'primary',
      VM217_SSH_COMMAND_TIMEOUT_SECONDS: '1',
      VM217_MUTATION_BUDGET_SECONDS: '15',
      VM217_TRANSPORT_KILL_AFTER_SECONDS: '1',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /remote state is unknown\. Keep rollback eligibility armed/);
    assert.match(result.stdout, /activation_exit_code=124 state=exact-committed-state/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('failures after runtime and release pointer commits reject candidate-active and mixed reconciliation', { skip: !bashAvailable }, () => {
  const candidate = createFixture();
  const mixed = createFixture();
  try {
    const candidateResult = runFixture(candidate, {
      FAKE_REMOTE_FAIL: 'true', FAKE_REMOTE_FAIL_POINT: 'runtime', FAKE_RECONCILE_STATE: 'secondary',
    });
    assert.equal(candidateResult.status, 86, `${candidateResult.stdout}\n${candidateResult.stderr}`);
    assert.match(candidateResult.stderr, /candidate or another non-target state/);
    assert.doesNotMatch(candidateResult.stdout, /vm217_rollback_transport_recovered/);
    assert.match(readFileSync(candidate.files.log, 'utf8'), /failure-point <runtime>/);

    const mixedResult = runFixture(mixed, {
      FAKE_REMOTE_FAIL: 'true', FAKE_REMOTE_FAIL_POINT: 'release', FAKE_RECONCILE_STATE: 'mixed',
    });
    assert.equal(mixedResult.status, 86, `${mixedResult.stdout}\n${mixedResult.stderr}`);
    assert.match(mixedResult.stderr, /did not prove the exact rollback target active/);
    assert.match(readFileSync(mixed.files.log, 'utf8'), /failure-point <release>/);
  } finally {
    rmSync(candidate.scratch, { recursive: true, force: true });
    rmSync(mixed.scratch, { recursive: true, force: true });
  }
});

test('runtime descriptor drift fails before any SSH or SCP invocation', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const descriptor = JSON.parse(readFileSync(fixture.files.descriptor, 'utf8'));
    descriptor.sha256 = 'f'.repeat(64);
    writeFileSync(fixture.files.descriptor, `${JSON.stringify(descriptor)}\n`);

    const result = runFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the retained runtime-secret descriptor/);
    assert.equal(existsSync(fixture.files.log), false, 'network stubs must not be called');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('signed compatibility proof is mandatory, exact, and attached before rollback transport', { skip: !bashAvailable }, () => {
  const missing = createFixture();
  const tampered = createFixture();
  const detached = createFixture();
  try {
    const missingArgs = fixtureArgs(missing);
    rmSync(missing.files.compatibilityProof);
    const missingResult = runFixture(missing, {}, missingArgs);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /Signed old-release compatibility proof must be/);

    const tamperedArgs = fixtureArgs(tampered);
    writeFileSync(tampered.files.compatibilityProof, `${readFileSync(tampered.files.compatibilityProof, 'utf8')} `);
    const tamperedResult = runFixture(tampered, {}, tamperedArgs);
    assert.notEqual(tamperedResult.status, 0);
    assert.match(tamperedResult.stderr, /does not match its expected digest/);

    writeFileSync(detached.files.compatibilitySignature, `${'f'.repeat(64)}\n`);
    const detachedResult = runFixture(detached);
    assert.notEqual(detachedResult.status, 0);
    assert.match(detachedResult.stderr, /signature is missing, invalid, or detached/);
  } finally {
    for (const fixture of [missing, tampered, detached]) rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('known_hosts must pin the requested host before any transport command runs', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, { FAKE_KNOWN_HOSTS_MATCH: 'false' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not contain the requested host/);
    assert.equal(existsSync(fixture.files.log), false, 'network stubs must not be called');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('remote rollback failure still cleans local and remote staging', { skip: !bashAvailable }, () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, { FAKE_REMOTE_FAIL: 'true', FAKE_RECONCILE_STATE: 'unknown' });
    assert.notEqual(result.status, 0);

    const log = readFileSync(fixture.files.log, 'utf8');
    assert.match(log, /<bash> <-s> <-->/);
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-rollback-transport\.FIXTURE01>/);
    const archiveMatch = log.match(/scp[^\n]*<([^>]*lunchlineup-rollback-transport\.[^>]*)>/);
    assert.ok(archiveMatch, 'fixture should observe the local archive path');
    assert.equal(existsSync(archiveMatch[1]), false, 'local archive must be removed after failure');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('non-full rollback SHA is rejected before input or network access', { skip: !bashAvailable }, () => {
  const result = spawnSync(bashPath, [
    bashPathFor(scriptPath),
    '--host', 'vm217.example',
    '--user', 'deploy',
    '--private-key', 'unused',
    '--known-hosts', 'unused',
    '--rollback-app-dir', 'unused',
    '--release-manifest', 'unused',
    '--runtime-env', 'unused',
    '--runtime-secret-descriptor', 'unused',
    '--launch-proof', 'unused',
    '--source-sha', 'deadbeef',
  ], { cwd: root, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full 40-character Git SHA/);
});
