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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = join(root, 'scripts', 'deploy-vm217-transport.sh');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;
const fixtureDeadlineAssertionMs = process.platform === 'win32' ? 20_000 : 10_000;
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const secondarySha = 'b'.repeat(40);
const launchProofUri = 'https://proofs.lunchlineup.com/releases/0123456789abcdef0123456789abcdef01234567/launch-proof.json';

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

function createTransportFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-transport-'));
  const fakeBin = join(scratch, 'bin');
  const files = {
    privateKey: join(scratch, 'id_ed25519'),
    knownHosts: join(scratch, 'known_hosts'),
    manifest: join(scratch, 'release-manifest.json'),
    runtimeEnv: join(scratch, 'runtime.env'),
    launchProof: join(scratch, 'launch-proof.json'),
    transportPid: join(scratch, 'transport.pid'),
    log: join(scratch, 'transport.log'),
  };

  mkdirSync(fakeBin);
  writeFileSync(files.privateKey, 'fixture-private-key\n');
  writeFileSync(files.knownHosts, 'vm217.example ssh-ed25519 AAAAfixture\n');
  writeFileSync(files.manifest, '{"sourceSha":"0123456789abcdef0123456789abcdef01234567"}\n');
  writeFileSync(files.runtimeEnv, 'FIXTURE_VALUE=not-a-secret\n');
  writeFileSync(files.launchProof, '{"status":"passed"}\n');

  writeExecutable(join(fakeBin, 'stat'), `#!/usr/bin/env bash
path="\${@: -1}"
case "$path" in
  *id_ed25519|*runtime.env) printf '600\\n' ;;
  *) printf '644\\n' ;;
esac
`);
  writeExecutable(join(fakeBin, 'scp'), `#!/usr/bin/env bash
printf 'scp\\n' >> "$FAKE_TRANSPORT_LOG"
scp_count="$(grep -c '^scp$' "$FAKE_TRANSPORT_LOG")"
if [[ -n "\${FAKE_SCP_FAIL_AT:-}" && "$scp_count" == "$FAKE_SCP_FAIL_AT" ]]; then
  exit 255
fi
`);
  writeExecutable(join(fakeBin, 'ssh'), `#!/usr/bin/env bash
printf 'ssh' >> "$FAKE_TRANSPORT_LOG"
remote_deploy=false
has_entrypoint=false
has_stdin_script=false
for arg in "$@"; do printf ' <%s>' "$arg" >> "$FAKE_TRANSPORT_LOG"; done
for arg in "$@"; do
  [[ "$arg" == */deploy-vm217-remote.sh ]] && has_entrypoint=true
  [[ "$arg" == "-s" ]] && has_stdin_script=true
done
[[ "$has_entrypoint" == "true" && "$has_stdin_script" == "true" ]] && remote_deploy=true
printf '\\n' >> "$FAKE_TRANSPORT_LOG"

is_cleanup=false
for arg in "$@"; do [[ "$arg" == "rm" ]] && is_cleanup=true; done
is_stage_allocation=false
for arg in "$@"; do [[ "$arg" == "mkdir" ]] && is_stage_allocation=true; done
if [[ "$is_stage_allocation" == "true" && "\${FAKE_STAGE_RESPONSE_LOSS:-false}" == "true" ]]; then
  exit 255
fi
if [[ "$remote_deploy" == "true" && "\${FAKE_REMOTE_RESPONSE_LOSS:-false}" == "true" ]]; then
  exit 255
fi
if [[ "\${FAKE_SSH_HANG:-false}" == "true" ]] \
  || [[ "$remote_deploy" == "true" && "\${FAKE_REMOTE_DEPLOY_HANG:-false}" == "true" ]] \
  || [[ "$is_cleanup" == "true" && "\${FAKE_SSH_CLEANUP_HANG:-false}" == "true" ]]; then
  if [[ "$remote_deploy" == "true" && "\${FAKE_REMOTE_SIGNAL_TERM:-false}" == "true" ]]; then
    transport_pid="$(tr -d '\\r\\n' < "$FAKE_TRANSPORT_PID_FILE")"
    [[ "$transport_pid" =~ ^[1-9][0-9]*$ ]] || exit 97
    (sleep 1; kill -TERM "$transport_pid") &
  fi
  exec sleep 10
fi

if [[ "$has_stdin_script" == "true" && "$remote_deploy" != "true" ]]; then
  printf 'reconciliation-start\\n' >> "$FAKE_TRANSPORT_LOG"
fi

previous=""
for arg in "$@"; do
  if [[ "$previous" == "sha256sum" && "$arg" == "--" ]]; then
    previous="sha256sum--"
    continue
  fi
  if [[ "$previous" == "sha256sum--" ]]; then
    case "$arg" in
      */release-manifest.json) printf '%s  %s\\n' "$FAKE_MANIFEST_SHA" "$arg" ;;
      */runtime.env) printf '%s  %s\\n' "$FAKE_RUNTIME_SHA" "$arg" ;;
      */launch-proof.json) printf '%s  %s\\n' "$FAKE_PROOF_SHA" "$arg" ;;
      */protected-channel) printf '%s  %s\\n' "$FAKE_PROTECTED_CHANNEL_SHA" "$arg" ;;
      */deploy-vm217-remote.sh) printf '%s  %s\\n' "$FAKE_ENTRYPOINT_SHA" "$arg" ;;
      *) exit 91 ;;
    esac
    exit 0
  fi
  previous="$arg"
done
`);

  return { scratch, fakeBin, files };
}

function runFixture(fixture, overrides = {}) {
  const env = {
    ...process.env,
    FAKE_TRANSPORT_LOG: bashPathFor(fixture.files.log),
    FAKE_TRANSPORT_PID_FILE: bashPathFor(fixture.files.transportPid),
    FAKE_MANIFEST_SHA: digest(readFileSync(fixture.files.manifest)),
    FAKE_RUNTIME_SHA: digest(readFileSync(fixture.files.runtimeEnv)),
    FAKE_PROOF_SHA: digest(readFileSync(fixture.files.launchProof)),
    FAKE_ENTRYPOINT_SHA: digest(readFileSync(join(root, 'scripts', 'deploy-vm217-remote.sh'))),
    FAKE_PROTECTED_CHANNEL_SHA: digest(`${launchProofUri}\n`),
    LAUNCH_PROOF_MANIFEST_URI: launchProofUri,
    PRODUCTION_WEB_URL: 'https://lunchlineup.example',
    ...overrides,
  };
  const args = [
    '-c',
    'PATH="$1:$PATH"; printf \'%s\\n\' "$BASHPID" > "$2"; export PATH; shift 2; exec bash "$@"',
    'transport-fixture',
    bashPathFor(fixture.fakeBin),
    bashPathFor(fixture.files.transportPid),
    bashPathFor(scriptPath),
    '--host', 'vm217.example',
    '--user', 'deploy',
    '--private-key', bashPathFor(fixture.files.privateKey),
    '--known-hosts', bashPathFor(fixture.files.knownHosts),
    '--release-manifest', bashPathFor(fixture.files.manifest),
    '--runtime-env', bashPathFor(fixture.files.runtimeEnv),
    '--launch-proof', bashPathFor(fixture.files.launchProof),
    '--source-sha', sourceSha,
  ];
  return spawnSync(bashPath, args, { cwd: root, encoding: 'utf8', env });
}

function realComposeReconciliationContract() {
  const compose = parse(read('docker-compose.yml'));
  const services = {};
  for (const [name, service] of Object.entries(compose.services)) {
    if (service.profiles?.length) continue;
    services[name] = {
      image: service.image
        .replace('${IMAGE_PREFIX:-lunchlineup}', 'lunchlineup-release')
        .replace('${IMAGE_TAG:-local}', sourceSha),
      ...(service.healthcheck ? { healthcheck: service.healthcheck } : {}),
      ...(service.restart !== undefined ? { restart: service.restart } : {}),
    };
  }
  return { services };
}

function runReconciliationFixture({
  legacy = false,
  compactContract = false,
  expectedPrevious = '',
  omitPrevious = false,
  runtimeOwnerSha = sourceSha,
  backupOwnerSha = sourceSha,
  backupProjectName = 'lunchlineup',
  timersReady = true,
  mixedService = '',
  missingService = '',
  unhealthyService = '',
  survivingWorker = false,
} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-reconciliation-'));
  const fakeBin = join(scratch, 'bin');
  const productionRoot = join(scratch, 'production');
  const runtimeRoot = join(scratch, 'runtime-env');
  const runtimePointer = join(runtimeRoot, 'current');
  const backupReleaseEnv = join(scratch, 'backup-release.env');
  const composeConfigFixture = join(scratch, 'compose-config.json');
  const serviceFixture = join(scratch, 'services.txt');
  const wrapper = join(scratch, 'run-reconciliation.sh');
  mkdirSync(fakeBin);
  mkdirSync(productionRoot);
  let activeTarget = '';
  let previousTarget = '';
  let runtimeTarget = '';
  let runtimeSha = '-';
  if (!legacy) {
    activeTarget = join(productionRoot, 'releases', sourceSha);
    mkdirSync(activeTarget, { recursive: true });
    writeFileSync(join(activeTarget, 'DEPLOYED_GIT_SHA'), `${sourceSha}\n`);
    writeFileSync(join(activeTarget, 'docker-compose.yml'), read('docker-compose.yml'));
    symlinkSync(activeTarget, join(productionRoot, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    if (expectedPrevious && !omitPrevious) {
      previousTarget = join(productionRoot, 'releases', expectedPrevious);
      mkdirSync(previousTarget, { recursive: true });
      writeFileSync(join(previousTarget, 'DEPLOYED_GIT_SHA'), `${expectedPrevious}\n`);
      symlinkSync(previousTarget, join(productionRoot, 'previous'), process.platform === 'win32' ? 'junction' : 'dir');
    }

    const runtimeBytes = 'FIXTURE_RUNTIME=true\n';
    runtimeSha = digest(runtimeBytes);
    runtimeTarget = join(runtimeRoot, 'by-release', runtimeOwnerSha, runtimeSha, 'runtime.env');
    mkdirSync(dirname(runtimeTarget), { recursive: true });
    writeFileSync(runtimeTarget, runtimeBytes);
    mkdirSync(runtimeRoot, { recursive: true });
    symlinkSync(process.platform === 'win32' ? dirname(runtimeTarget) : runtimeTarget, runtimePointer, process.platform === 'win32' ? 'junction' : 'file');
    writeFileSync(backupReleaseEnv, [
      'IMAGE_PREFIX=lunchlineup-release',
      `IMAGE_TAG=${backupOwnerSha}`,
      `COMPOSE_PROJECT_NAME=${backupProjectName}`,
      `COMPOSE_SERVICE_ENV_FILE=${bashPathFor(runtimeTarget)}`,
      `PRODUCTION_RUNTIME_ENV_SHA256=${runtimeSha}`,
      '',
    ].join('\n'));

    const contract = realComposeReconciliationContract();
    if (compactContract) {
      contract.services = {
        proxy: contract.services.proxy,
        'pdf-parser': contract.services['pdf-parser'],
      };
    }
    writeFileSync(composeConfigFixture, `${JSON.stringify(contract)}\n`);
    writeFileSync(serviceFixture, `${Object.entries(contract.services).map(([name, service]) => {
      const hasHealth = service.healthcheck && service.healthcheck.disable !== true
        && JSON.stringify(service.healthcheck.test) !== JSON.stringify(['NONE']);
      const mode = String(service.restart).toLowerCase() === 'no' ? 'completed' : hasHealth ? 'healthy' : 'running';
      return `${name}|${mode}|${service.image}`;
    }).join('\n')}\n`);
  }
  writeExecutable(join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
headers=""
body=""
while (( $# > 0 )); do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    --output) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
: > "$headers"
if [[ "\${FAKE_LEGACY}" == "true" ]]; then
  printf 'Lunch Lineup legacy fixture\n' > "$body"
else
  printf 'X-LunchLineUp-Release: %s\r\n' "\${FAKE_SOURCE_SHA}" > "$headers"
  printf 'v2 fixture\n' > "$body"
fi
printf '200'
`);
  writeExecutable(join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "compose" ]]; then
  cat "$FAKE_COMPOSE_CONFIG"
  exit 0
fi
service=""
for arg in "$@"; do
  case "$arg" in
    label=com.docker.compose.service=*) service="\${arg##*=}" ;;
  esac
done
if [[ "\${FAKE_LEGACY}" == "true" ]]; then
  [[ "\${FAKE_SURVIVING_WORKER}" == "true" ]] && printf 'surviving-worker\n'
  exit 0
fi
if [[ "\${1:-}" == "ps" ]]; then
  if [[ -n "$service" ]]; then
    [[ "$service" == "\${FAKE_MISSING_SERVICE}" ]] || printf 'fixture-%s\n' "$service"
  else
    while IFS='|' read -r fixture_service _; do
      [[ -n "$fixture_service" && "$fixture_service" != "\${FAKE_MISSING_SERVICE}" ]] && printf 'fixture-%s\n' "$fixture_service"
    done < "$FAKE_SERVICE_FIXTURE"
  fi
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  container_id="\${@: -1}"
  service="\${container_id#fixture-}"
  record="$(awk -F '|' -v wanted="$service" '$1 == wanted { print; exit }' "$FAKE_SERVICE_FIXTURE")"
  [[ -n "$record" ]] || exit 2
  IFS='|' read -r _ mode image <<< "$record"
  state=running
  health=none
  exit_code=0
  case "$mode" in
    healthy) health=healthy ;;
    completed) state=exited ;;
  esac
  [[ "$service" != "\${FAKE_UNHEALTHY_SERVICE}" ]] || health=unhealthy
  if [[ "$service" == "\${FAKE_MIXED_SERVICE}" ]]; then
    if [[ "$image" == *@sha256:* ]]; then image="\${image%sha256:*}sha256:\${FAKE_SECONDARY_DIGEST}"; else image="\${image%:*}:\${FAKE_SECONDARY_SHA}"; fi
  fi
  printf '%s|%s|%s|%s|lunchlineup|%s/docker-compose.yml|%s\n' \
    "$state" "$health" "$exit_code" "\${FAKE_ACTIVE_TARGET}" "\${FAKE_ACTIVE_TARGET}" "$image"
  exit 0
fi
exit 2
`);
  writeExecutable(join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
[[ "\${FAKE_LEGACY}" == "true" ]] && exit 0
[[ "\${FAKE_TIMERS_READY}" == "true" ]]
`);
  writeExecutable(join(fakeBin, 'python3'), `#!/usr/bin/env bash
if [[ -x /c/Python314/python.exe ]]; then exec /c/Python314/python.exe "$@"; fi
exec /usr/bin/python3 "$@"
`);
  writeExecutable(join(fakeBin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
path="\${@: -1}"
if [[ "\${1:-}" == "-c" && "\${2:-}" == "%u:%g:%a" ]]; then
  case "$path" in
    "\${FAKE_RUNTIME_TARGET}") printf '0:4242:640\n'; exit 0 ;;
    "\${FAKE_BACKUP_RELEASE_ENV}") printf '0:0:640\n'; exit 0 ;;
  esac
fi
exec /usr/bin/stat "$@"
`);
  writeExecutable(join(fakeBin, 'readlink'), `#!/usr/bin/env bash
set -euo pipefail
path="\${@: -1}"
case "$path" in
  "\${FAKE_PRODUCTION_ROOT}/current") printf '%s\n' "\${FAKE_ACTIVE_TARGET}" ;;
  "\${FAKE_PRODUCTION_ROOT}/previous") printf '%s\n' "\${FAKE_PREVIOUS_TARGET}" ;;
  "\${FAKE_RUNTIME_POINTER}") printf '%s\n' "\${FAKE_RUNTIME_TARGET}" ;;
  *) /usr/bin/readlink "$@" ;;
esac
`);
  writeExecutable(wrapper, `#!/usr/bin/env bash
set -euo pipefail
helper="$1"
production_root="$2"
primary="$3"
secondary="$4"
expected_previous="$5"
runtime_sha="$6"
runtime_pointer="$7"
backup_release_env="$8"
web_b64="$9"
legacy_b64="\${10}"
fake_bin="\${11}"
PATH="$fake_bin:$PATH"
export PATH
source "$helper"
vm217_run_reconcile_ssh() {
  shift
  "$@"
}
vm217_reconcile_release_state fixture "$production_root" "$primary" "$secondary" "$expected_previous" "$runtime_sha" "$runtime_pointer" "$backup_release_env" lunchlineup "$web_b64" "$legacy_b64"
`);
  const result = spawnSync(bashPath, [
    bashPathFor(wrapper),
    bashPathFor(join(root, 'scripts', 'vm217-transport-deadlines.sh')),
    bashPathFor(productionRoot),
    legacy ? 'legacy' : sourceSha,
    legacy ? '-' : secondarySha,
    expectedPrevious || '-',
    legacy ? '-' : runtimeSha,
    bashPathFor(runtimePointer),
    bashPathFor(backupReleaseEnv),
    Buffer.from('https://lunchlineup.example/').toString('base64'),
    Buffer.from('Lunch Lineup').toString('base64'),
    bashPathFor(fakeBin),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_ACTIVE_TARGET: bashPathFor(activeTarget),
      FAKE_BACKUP_RELEASE_ENV: bashPathFor(backupReleaseEnv),
      FAKE_COMPOSE_CONFIG: bashPathFor(composeConfigFixture),
      FAKE_LEGACY: String(legacy),
      FAKE_MISSING_SERVICE: missingService,
      FAKE_MIXED_SERVICE: mixedService,
      FAKE_PRODUCTION_ROOT: bashPathFor(productionRoot),
      FAKE_PREVIOUS_TARGET: bashPathFor(previousTarget),
      FAKE_RUNTIME_POINTER: bashPathFor(runtimePointer),
      FAKE_RUNTIME_TARGET: bashPathFor(runtimeTarget),
      FAKE_SERVICE_FIXTURE: bashPathFor(serviceFixture),
      FAKE_SECONDARY_SHA: secondarySha,
      FAKE_SECONDARY_DIGEST: 'f'.repeat(64),
      FAKE_SOURCE_SHA: sourceSha,
      FAKE_SURVIVING_WORKER: String(survivingWorker),
      FAKE_TIMERS_READY: String(timersReady),
      FAKE_UNHEALTHY_SERVICE: unhealthyService,
    },
  });
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

test('VM217 transport helper keeps the SSH and execution contract fail closed', () => {
  const script = read('scripts/deploy-vm217-transport.sh');

  assert.match(script, /set -euo pipefail/);
  assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /UserKnownHostsFile=\$KNOWN_HOSTS/);
  assert.match(script, /BatchMode=yes/);
  assert.match(script, /PasswordAuthentication=no/);
  assert.match(script, /IdentitiesOnly=yes/);
  assert.match(script, /ConnectTimeout=\$VM217_SSH_CONNECT_TIMEOUT_SECONDS/);
  assert.match(script, /ServerAliveInterval=\$VM217_SSH_SERVER_ALIVE_INTERVAL_SECONDS/);
  assert.match(script, /vm217_run_cleanup_ssh "remote deployment staging cleanup"/);
  assert.match(script, /vm217_begin_mutation_budget/);
  assert.match(script, /remote_stage_candidate="\/tmp\/lunchlineup-ci-transport\.\$stage_token"/);
  assert.match(script, /mkdir -m 700 -- "\$REMOTE_STAGE"/);
  assert.match(script, /trap cleanup_remote_stage EXIT/);
  assert.match(script, /handle_transport_signal/);
  assert.match(script, /reconciling exact release\/services\/traffic state before any next action/);
  assert.match(script, /rm -rf -- "\$REMOTE_STAGE"/);
  assert.match(script, /git -C "\$REPO_ROOT" ls-files --error-unmatch/);
  assert.match(script, /sha256sum -- "\$path"/);
  assert.match(script, /LAUNCH_PROOF_PATH=\$\{12\}/);
  assert.match(script, /PRODUCTION_API_HEALTH_URL_B64/);
  assert.match(script, /PRODUCTION_WEB_URL_B64/);
  assert.match(script, /REMOTE_PROTECTED_CHANNEL/);
  assert.match(script, /Protected launch-proof channel must have mode 0600/);
  assert.doesNotMatch(script, /LAUNCH_PROOF_MANIFEST_URI_B64/);
  assert.match(script, /base64 --decode/);
  assert.match(script, /candidate_app="\$release_root\/\$source_sha"/);
  assert.match(script, /manifest\.get\("deploymentContract", \{\}\)\.get\("files"\)/);
  assert.match(script, /"ACTIVE_RELEASE_POINTER=\$production_root\/current"/);
  assert.match(script, /exec env "\$\{remote_env\[@\]\}" bash "\$candidate_entrypoint"/);
  assert.match(script, /vm217_reconcile_release_state/);
  assert.ok(
    script.indexOf('vm217_begin_mutation_budget') < script.indexOf('remote deployment staging allocation'),
    'aggregate mutation budget must begin before remote staging allocation',
  );
  assert.doesNotMatch(script, /\beval\b|\$\{?SHELL\}?|\bbash\s+-c\b|\bsh\s+-c\b/);
});

test('VM217 transport fixture verifies bytes, invokes the entrypoint, and cleans staging', { skip: !bashAvailable }, () => {
  const fixture = createTransportFixture();
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /vm217_transport_ok sha=0123456789abcdef0123456789abcdef01234567/);

    const log = readFileSync(fixture.files.log, 'utf8');
    assert.equal((log.match(/^scp$/gm) ?? []).length, 4);
    assert.match(log, /StrictHostKeyChecking=yes/);
    assert.match(log, /UserKnownHostsFile=/);
    assert.match(log, /ConnectTimeout=15/);
    assert.match(log, /ServerAliveInterval=10/);
    assert.match(log, /sha256sum/);
    assert.match(log, /<bash> <-s> <-->/);
    assert.match(log, /<\/opt\/lunchlineup\/scripts\/deploy-vm217-remote\.sh>/);
    assert.doesNotMatch(log, /PRODUCTION_API_HEALTH_URL=|LAUNCH_PROOF_MANIFEST_URI=/);
    assert.doesNotMatch(log, new RegExp(`${launchProofUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${Buffer.from(launchProofUri).toString('base64')}`));
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-ci-transport\.[A-Za-z0-9]+>/);
    assert.doesNotMatch(log, /FIXTURE_VALUE=not-a-secret|fixture-private-key/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('VM217 deploy timeout always runs bounded exact-state reconciliation without hanging', { skip: !bashAvailable }, () => {
  const fixture = createTransportFixture();
  try {
    const startedAt = Date.now();
    const result = runFixture(fixture, {
      FAKE_REMOTE_DEPLOY_HANG: 'true',
      VM217_SSH_COMMAND_TIMEOUT_SECONDS: '1',
      VM217_MUTATION_BUDGET_SECONDS: '30',
      VM217_TRANSPORT_KILL_AFTER_SECONDS: '1',
    });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /remote state is unknown\. Keep rollback eligibility armed/);
    const log = readFileSync(fixture.files.log, 'utf8');
    assert.ok((log.match(/<bash> <-s> <-->/g) ?? []).length >= 2, `timeout must trigger an independent SSH reconciliation\n${log}`);
    assert.ok(Date.now() - startedAt < fixtureDeadlineAssertionMs, 'transport and reconciliation must respect their deadlines');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('TERM during remote deploy reconciles before known-path cleanup and preserves cancellation status', { skip: !bashAvailable }, () => {
  const fixture = createTransportFixture();
  try {
    const result = runFixture(fixture, {
      FAKE_REMOTE_DEPLOY_HANG: 'true',
      FAKE_REMOTE_SIGNAL_TERM: 'true',
      VM217_SSH_COMMAND_TIMEOUT_SECONDS: '30',
      VM217_MUTATION_BUDGET_SECONDS: '60',
      VM217_SSH_RECONCILE_TIMEOUT_SECONDS: '5',
      VM217_SSH_CLEANUP_TIMEOUT_SECONDS: '5',
    });
    assert.equal(result.status, 143, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /received TERM after remote operations began; attempting one bounded authenticated reconciliation before cleanup/);

    const log = readFileSync(fixture.files.log, 'utf8');
    const deploy = log.indexOf('</opt/lunchlineup/scripts/deploy-vm217-remote.sh>');
    const reconciliation = log.indexOf('reconciliation-start', deploy);
    const cleanup = log.indexOf('rm> <-rf> <--> </tmp/lunchlineup-ci-transport.', reconciliation);
    assert.ok(deploy >= 0 && reconciliation > deploy, 'TERM must reconcile after deployment starts');
    assert.ok(cleanup > reconciliation, 'reconciliation must precede known-path staging cleanup');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('allocation response loss and partial upload both reconcile and clean the runner-known remote stage', { skip: !bashAvailable }, () => {
  for (const overrides of [
    { FAKE_STAGE_RESPONSE_LOSS: 'true' },
    { FAKE_SCP_FAIL_AT: '2' },
    { FAKE_REMOTE_RESPONSE_LOSS: 'true' },
  ]) {
    const fixture = createTransportFixture();
    try {
      const result = runFixture(fixture, overrides);
      assert.equal(result.status, 255, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /reconciling exact release\/services\/traffic state before any next action/);
      const log = readFileSync(fixture.files.log, 'utf8');
      const allocation = log.match(/<mkdir> <-m> <700> <--> <(\/tmp\/lunchlineup-ci-transport\.[A-Za-z0-9]+)>/);
      assert.ok(allocation, log);
      const reconciliation = log.indexOf('reconciliation-start');
      const cleanup = log.indexOf(`rm> <-rf> <--> <${allocation[1]}>`);
      assert.ok(reconciliation > -1 && cleanup > reconciliation, log);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('VM217 aggregate budget exhaustion prevents the first upload and still runs bounded reconciliation and cleanup', { skip: !bashAvailable }, () => {
  const fixture = createTransportFixture();
  const bashEnv = join(fixture.scratch, 'force-budget-exhaustion.sh');
  try {
    writeFileSync(bashEnv, `
trap 'case "$BASH_COMMAND" in *vm217_run_scp*release\\ manifest\\ upload*) VM217_MUTATION_BUDGET_STARTED_AT_SECONDS=$((SECONDS - VM217_MUTATION_BUDGET_SECONDS)) ;; esac' DEBUG
`, { mode: 0o600 });
    const result = runFixture(fixture, {
      BASH_ENV: bashPathFor(bashEnv),
      VM217_MUTATION_BUDGET_SECONDS: '30',
    });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /aggregate mutation deadline exhausted before release manifest upload/);
    const log = readFileSync(fixture.files.log, 'utf8');
    assert.equal((log.match(/^scp$/gm) ?? []).length, 0, 'exhausted budget must not invoke SCP');
    assert.ok((log.match(/<bash> <-s> <-->/g) ?? []).length >= 1, `exhaustion must run read-only reconciliation\n${log}`);
    assert.match(log, /rm> <-rf> <--> <\/tmp\/lunchlineup-ci-transport\.[A-Za-z0-9]+>/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('shared reconciliation proves exact retained pointer, service owner, public release, and legacy traffic', () => {
  const deadlines = read('scripts/vm217-transport-deadlines.sh');
  const ci = read('.github/workflows/ci.yml');
  assert.match(deadlines, /active_target" == "\$production_root\/releases\/\$active_sha"/);
  assert.match(deadlines, /docker compose[\s\S]*config --format json/);
  assert.match(deadlines, /service\.get\("profiles"\)/);
  assert.match(deadlines, /fixed-digest nor release-SHA owned/);
  assert.match(deadlines, /mode = "completed" if restart == "no" else "healthy" if has_health else "running"/);
  assert.match(deadlines, /com\.docker\.compose\.project\.config_files/);
  assert.match(deadlines, /"\$image" == "\$expected_image"/);
  assert.match(deadlines, /active runtime environment is not exact release\/digest-owned state/);
  assert.match(deadlines, /backup release environment is not exact active release\/runtime ownership/);
  assert.match(deadlines, /traffic_release" == "\$active_sha"/);
  assert.match(deadlines, /legacy_traffic=false/);
  assert.match(deadlines, /legacy state still has release-owned v2 project containers/);
  assert.match(deadlines, /systemctl is-active --quiet apache2/);
  assert.match(deadlines, /legacy_traffic=true/);
  assert.match(
    ci,
    /name: "17\. Guarded production deploy; Reconcile exact VM217 active release, services, and legacy traffic state; cleanup"[\s\S]*VM217_RECONCILE_ONLY=true env/,
  );
  assert.match(
    ci,
    /if \[ "\$deploy_status" -ne 0 \]; then exit "\$deploy_status"; fi[\s\S]*if \[ "\$reconcile_status" -ne 0 \]; then exit "\$reconcile_status"; fi/,
  );
});

test('shared reconciliation uses the real Compose proxy/pdf-parser contract and rejects missing, unhealthy, or mixed services', { skip: !bashAvailable }, () => {
  const contract = realComposeReconciliationContract();
  assert.match(contract.services.proxy.image, /^caddy:2-alpine@sha256:[a-f0-9]{64}$/);
  assert.equal(contract.services['pdf-parser'].image, `lunchlineup-release/worker:${sourceSha}`);
  assert.ok(Object.keys(contract.services).length >= 20, 'real production Compose must contribute the complete default service inventory');
  for (const service of ['postgres', 'redis', 'rabbitmq', 'prometheus', 'alertmanager', 'loki', 'promtail', 'otel-collector', 'tempo', 'grafana']) {
    assert.ok(contract.services[service], `real production Compose must include ${service}`);
  }

  const exact = runReconciliationFixture({ compactContract: true });
  assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`);
  assert.match(exact.stdout, new RegExp(`exact_state=primary active_release_sha=${sourceSha}`));
  assert.match(exact.stdout, /service_count=2/);

  const mixed = runReconciliationFixture({ compactContract: true, mixedService: 'proxy' });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /exact active Compose image and ownership/);

  const missing = runReconciliationFixture({ compactContract: true, missingService: 'pdf-parser' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /exactly one healthy pdf-parser service/);

  const unhealthy = runReconciliationFixture({ compactContract: true, unhealthyService: 'pdf-parser' });
  assert.notEqual(unhealthy.status, 0);
  assert.match(unhealthy.stderr, /exactly one healthy pdf-parser service/);

  const surviving = runReconciliationFixture({ legacy: true, survivingWorker: true });
  assert.notEqual(surviving.status, 0);
  assert.match(surviving.stderr, /legacy state still has release-owned v2 project containers/);
});

test('rollback reconciliation rejects missing previous, candidate-owned runtime/backup, and inactive timers', { skip: !bashAvailable }, () => {
  const cases = [
    [{ omitPrevious: true }, /previous release pointer is missing/],
    [{ runtimeOwnerSha: secondarySha }, /runtime environment is not exact release\/digest-owned state/],
    [{ backupOwnerSha: secondarySha }, /backup release environment is not exact active release\/runtime ownership/],
    [{ backupProjectName: 'release-scoped-project' }, /backup release environment is not exact active release\/runtime ownership/],
    [{ timersReady: false }, /required backup timer is not enabled/],
  ];
  for (const [overrides, expectedError] of cases) {
    const result = runReconciliationFixture({
      compactContract: true,
      expectedPrevious: secondarySha,
      ...overrides,
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, expectedError);
    assert.doesNotMatch(result.stdout, /vm217_reconciliation_ok/);
  }
});

test('VM217 remote cleanup has its own deadline and preserves timeout status', { skip: !bashAvailable }, () => {
  const fixture = createTransportFixture();
  try {
    const startedAt = Date.now();
    const result = runFixture(fixture, {
      FAKE_SSH_CLEANUP_HANG: 'true',
      VM217_SSH_CLEANUP_TIMEOUT_SECONDS: '1',
      VM217_TRANSPORT_KILL_AFTER_SECONDS: '1',
    });
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /deadline exceeded during remote deployment staging cleanup after 1s/);
    assert.match(result.stderr, /Remote transport staging cleanup failed/);
    assert.ok(Date.now() - startedAt < fixtureDeadlineAssertionMs, 'cleanup must respect its independent deadline');
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('VM217 transport rejects a non-full source SHA before network access', { skip: !bashAvailable }, () => {
  const result = spawnSync(bashPath, [
    scriptPath,
    '--host', 'vm217.example',
    '--user', 'deploy',
    '--private-key', 'unused',
    '--known-hosts', 'unused',
    '--release-manifest', 'unused',
    '--runtime-env', 'unused',
    '--launch-proof', 'unused',
    '--source-sha', 'deadbeef',
  ], { cwd: root, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full 40-character Git SHA/);
});

test('VM217 transport documentation inventories and contract stay aligned', () => {
  assert.match(read('scripts/README.md'), /`deploy-vm217-transport\.sh`/);
  assert.match(read('tests/deploy/README.md'), /`deploy-vm217-transport\.test\.mjs`/);
  const runbook = read('docs/runbooks/production-readiness.md');
  assert.match(runbook, /CI-To-VM217 Transport Contract/);
  assert.match(runbook, /StrictHostKeyChecking=yes/);
  assert.match(runbook, /network and VPN credentials remain external/i);
});
