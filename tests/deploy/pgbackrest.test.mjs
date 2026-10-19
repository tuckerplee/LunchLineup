import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProductionEnv, verifyRepo3Files } from '../../scripts/check-production-env.mjs';
import { BASE } from '../fixtures/production-env-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const bashCandidates = ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'];
const bash = bashCandidates.find((b) => spawnSync(b, ['--version']).status === 0);
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const dockerfile = read('infrastructure/docker/Dockerfile.postgres');
const overlay = read('infrastructure/postgres/compose.pgbackrest.yml');
const compose = read('docker-compose.yml');
const entrypoint = join(root, 'infrastructure/postgres/lunchlineup-postgres-entrypoint.sh');
const stripComments = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const KEYS = ['PGBACKREST_ENABLED', 'PGBACKREST_STANZA', 'PGBACKREST_SFTP_HOST', 'PGBACKREST_SFTP_USER', 'PGBACKREST_REPO_PATH',
  'PGBACKREST_SFTP_KEY_FILE', 'PGBACKREST_SFTP_KNOWN_HOSTS_FILE', 'PGBACKREST_CIPHER_PASS_FILE'];

test('postgres image: digest-pinned base, pinned pgbackrest package, wrapper entrypoint, no secrets', () => {
  assert.match(dockerfile, /^FROM postgres:16-alpine@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG PGBACKREST_VERSION=\d+\.\d+\.\d+-r\d+$/m);
  assert.match(dockerfile, /apk add --no-cache su-exec "pgbackrest=\$\{PGBACKREST_VERSION\}"/);
  assert.match(dockerfile, /pgbackrest version/);
  assert.match(dockerfile, /install -d -o postgres -g postgres -m 0750 \/var\/spool\/pgbackrest \/var\/log\/pgbackrest/);
  assert.match(dockerfile, /COPY --chmod=0755 infrastructure\/postgres\/lunchlineup-postgres-entrypoint\.sh /);
  assert.match(dockerfile, /^ENTRYPOINT \["lunchlineup-postgres-entrypoint\.sh"\]$/m);
  assert.doesNotMatch(dockerfile, /cipher|PRIVATE KEY|known_hosts|password/i);
  assert.match(read('.gitattributes'), /infrastructure\/postgres\/\*\.sh text eol=lf/);
});

test('base compose keeps pgBackRest OFF: archive off, data network only, no egress network or pgbackrest volumes', () => {
  assert.match(compose, /archive_mode=\$\{POSTGRES_ARCHIVE_MODE:-off\}/);
  assert.match(compose, /archive_command=\$\{POSTGRES_ARCHIVE_COMMAND:-\/bin\/false\}/);
  assert.doesNotMatch(stripComments(compose), /pgbackrest-egress|pgbackrest_(spool|log)|LL_PGBR_|PGBACKREST_/);
  const postgres = stripComments(compose.slice(compose.indexOf('\n  postgres:\n'), compose.indexOf('\n  redis:\n')));
  assert.match(postgres, /networks:\n      - data\n/);
  assert.doesNotMatch(postgres, /pgbackrest-egress/);
});

test('pgBackRest overlay: postgres only, dedicated egress network, read-only key mounts, required settings', () => {
  const services = overlay.split('\nnetworks:')[0];
  assert.deepEqual([...services.matchAll(/^  ([a-z0-9-]+):$/gm)].map((m) => m[1]), ['postgres']);
  for (const key of ['PGBACKREST_STANZA', 'PGBACKREST_SFTP_HOST', 'PGBACKREST_SFTP_USER', 'PGBACKREST_REPO_PATH',
    'PGBACKREST_SFTP_KEY_FILE', 'PGBACKREST_SFTP_KNOWN_HOSTS_FILE', 'PGBACKREST_CIPHER_PASS_FILE']) {
    assert.match(overlay, new RegExp(`\\$\\{${key}:\\?`), `${key} must be required by the overlay`);
  }
  assert.match(overlay, /LL_PGBR_ENABLED: "true"/);
  // archive-async daemons must not be reparented to the postmaster (PID 1): a non-zero
  // exit there is treated as a crashed backend and loops postgres through crash recovery.
  assert.match(overlay, /^  postgres:\n(?:    #[^\n]*\n)*    init: true$/m);
  assert.match(overlay, /PGBACKREST_CONFIG: \/run\/pgbackrest\/pgbackrest\.conf/);
  assert.match(overlay, /\/run\/pgbackrest:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=70,gid=70/);
  assert.equal([...overlay.matchAll(/read_only: true/g)].length, 3);
  assert.equal([...overlay.matchAll(/create_host_path: false/g)].length, 3);
  assert.match(overlay, /pgbackrest_spool:\/var\/spool\/pgbackrest/);
  assert.match(overlay, /pgbackrest_log:\/var\/log\/pgbackrest/);
  assert.match(overlay, /^      data:\n      pgbackrest-egress:\n        gw_priority: 1$/m);
  const network = overlay.slice(overlay.indexOf('\nnetworks:'));
  assert.match(network, /pgbackrest-egress:\n    driver: bridge\n    internal: false\n    driver_opts:\n      com\.docker\.network\.bridge\.enable_icc: "false"/);
  assert.doesNotMatch(stripComments(overlay), /outbound-egress|S3_|BACKUP_|PITR_/);
});

// --- wrapper entrypoint -----------------------------------------------------
function entrypointRun(env, args, { files = {}, noRuntimeDir = false } = {}) {
  const work = tmp('pgbr-ep-');
  const bin = join(work, 'bin');
  const src = join(work, 'src');
  const dest = join(work, 'dest');
  mkdirSync(bin); mkdirSync(src);
  if (!noRuntimeDir) mkdirSync(dest);
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n');
  writeFileSync(join(bin, 'docker-entrypoint.sh'), '#!/bin/sh\necho "STOCK $*"\n');
  // install/chown stubs so the happy path renders as a non-root user (ownership is irrelevant here)
  writeFileSync(join(bin, 'install'), [
    '#!/bin/sh',
    'd=0; while [ $# -gt 0 ]; do case "$1" in -d) d=1; shift ;; -o|-g|-m) shift 2 ;; *) break ;; esac; done',
    'if [ $d = 1 ]; then mkdir -p "$@"; else cp "$1" "$2"; chmod 600 "$2"; fi',
    '',
  ].join('\n'));
  writeFileSync(join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'install'), 0o755);
  chmodSync(join(bin, 'chown'), 0o755);
  chmodSync(join(bin, 'id'), 0o755);
  chmodSync(join(bin, 'docker-entrypoint.sh'), 0o755);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  const result = spawnSync(bash, [toPosix(entrypoint), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${toPosix(bin)}:${process.env.PATH}`, LL_PGBR_RUNTIME_DIR: toPosix(dest), LL_PGBR_SOURCE_DIR: toPosix(src), ...env },
  });
  result.dest = dest;
  result.conf = (name = 'pgbackrest.conf') => { try { return readFileSync(join(dest, name), 'utf8'); } catch { return null; } };
  return result;
}
const enabledEnv = {
  LL_PGBR_ENABLED: 'true', LL_PGBR_STANZA: 'lunchlineup', LL_PGBR_SFTP_HOST: 'p0-nas01', LL_PGBR_SFTP_PORT: '22',
  LL_PGBR_SFTP_USER: 'pgbr-lunchlineup', LL_PGBR_REPO_PATH: '/repo', LL_PGBR_PG_USER: 'lunchlineup_admin',
};
const goodFiles = {
  sftp_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n',
  known_hosts: 'p0-nas01 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc\n',
  cipher_pass: 'abcdef0123456789\n',
};

test('entrypoint script is valid shell', { skip: !bash }, () => {
  const r = spawnSync(bash, ['-n', toPosix(entrypoint)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(entrypoint, 'utf8'), /\r/, 'must keep LF endings');
});

test('entrypoint default (disabled): pure passthrough to the stock entrypoint, nothing rendered', { skip: !bash }, () => {
  const r = entrypointRun({}, ['postgres', '-c', 'archive_mode=off']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'STOCK postgres -c archive_mode=off');
  const off = entrypointRun({ LL_PGBR_ENABLED: 'false' }, ['postgres']);
  assert.equal(off.stdout.trim(), 'STOCK postgres');
  const cli = entrypointRun({}, ['pgbackrest', 'info']);
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /pgBackRest is not enabled/);
});

test('entrypoint fails closed when enabled but anything required is missing', { skip: !bash }, () => {
  const cases = [
    ['no key file', enabledEnv, { ...goodFiles, sftp_key: undefined }, /PGBACKREST_SFTP_KEY_FILE: mounted file .* missing, empty or unreadable/],
    ['empty key file', enabledEnv, { ...goodFiles, sftp_key: '' }, /PGBACKREST_SFTP_KEY_FILE/],
    ['no known_hosts', enabledEnv, { ...goodFiles, known_hosts: undefined }, /PGBACKREST_SFTP_KNOWN_HOSTS_FILE/],
    ['no cipher pass', enabledEnv, { ...goodFiles, cipher_pass: undefined }, /PGBACKREST_CIPHER_PASS_FILE/],
    ['not a private key', enabledEnv, { ...goodFiles, sftp_key: 'hello\n' }, /does not look like a private key/],
    ['known_hosts lacks the host', enabledEnv, { ...goodFiles, known_hosts: 'other-host ssh-ed25519 AAAA\n' }, /no entry for p0-nas01/],
    ['no stanza', { ...enabledEnv, LL_PGBR_STANZA: '' }, goodFiles, /PGBACKREST_STANZA is required/],
    ['bad host', { ...enabledEnv, LL_PGBR_SFTP_HOST: 'a b;c' }, goodFiles, /PGBACKREST_SFTP_HOST has an invalid value/],
    ['relative repo path', { ...enabledEnv, LL_PGBR_REPO_PATH: 'repo' }, goodFiles, /PGBACKREST_REPO_PATH has an invalid value/],
  ];
  for (const [name, env, files, pattern] of cases) {
    const present = Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined));
    const r = entrypointRun(env, ['postgres'], { files: present });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, pattern, name);
    assert.doesNotMatch(r.stdout, /STOCK/, `${name}: postgres must not start`);
  }
  const noTmpfs = entrypointRun(enabledEnv, ['postgres'], { files: goodFiles, noRuntimeDir: true });
  assert.notEqual(noTmpfs.status, 0);
  assert.match(noTmpfs.stderr, /\(tmpfs\) is not mounted/);
});

test('entrypoint forces the archive settings and pgbackrest runs as postgres (source contract)', () => {
  const text = readFileSync(entrypoint, 'utf8');
  assert.match(text, /set -- "\$@" -c archive_mode=on -c "archive_command=pgbackrest --stanza=\$STANZA archive-push %p"/);
  assert.match(text, /exec su-exec postgres "\$@"/);
  for (const line of ['repo2-type=sftp', 'repo2-sftp-host-key-check-type=strict', 'repo2-sftp-host-key-hash-type=sha256',
    'repo2-cipher-type=aes-256-cbc', 'repo2-retention-full-type=count', 'archive-async=y', 'spool-path=/var/spool/pgbackrest',
    'log-path=/var/log/pgbackrest', 'pg1-socket-path=/var/run/postgresql']) {
    assert.ok(text.includes(line), line);
  }
});

// --- deploy scripts -----------------------------------------------------------
function stubDocker({ failOn = '' } = {}) {
  const bin = tmp('pgbr-bin-');
  const log = join(bin, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${toPosix(log)}"
if [[ "$*" == *"ps --format"* ]]; then echo healthy; exit 0; fi
if [[ -n "${failOn}" && "$*" == *"${failOn}"* ]]; then echo "stub failure" >&2; exit 1; fi
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { bin, log };
}

function hostFiles({ keyMode = 0o600 } = {}) {
  const dir = tmp('pgbr-host-');
  const env = {};
  for (const [key, name, mode] of [['PGBACKREST_SFTP_KEY_FILE', 'key', keyMode], ['PGBACKREST_SFTP_KNOWN_HOSTS_FILE', 'known_hosts', 0o644], ['PGBACKREST_CIPHER_PASS_FILE', 'cipher', 0o600]]) {
    writeFileSync(join(dir, name), 'x\n');
    chmodSync(join(dir, name), mode);
    env[key] = toPosix(join(dir, name));
  }
  return env;
}

function runtimeEnvFile(extra = {}, { drop = [] } = {}) {
  const values = {
    PGBACKREST_ENABLED: 'true', PGBACKREST_STANZA: 'lunchlineup', PGBACKREST_SFTP_HOST: 'p0-nas01',
    PGBACKREST_SFTP_USER: 'pgbr-lunchlineup', PGBACKREST_REPO_PATH: '/repo', ...hostFiles(), ...extra,
  };
  for (const key of drop) delete values[key];
  const file = join(tmp('pgbr-env-'), 'runtime.env');
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return toPosix(file);
}

const scripts = {
  release: { path: join(root, 'scripts/deploy-release.sh'), setup: 'configure_target production;', env: { PROD_BIND_IP: '10.231.10.120' } },
  pilot: { path: join(root, 'scripts/deploy-private-pilot.sh'), setup: '', env: {} },
};

function runScript(which, snippet, { bin, env = {} } = {}) {
  const s = scripts[which];
  const path = bin ? `${toPosix(bin)}:${process.env.PATH}` : process.env.PATH;
  return spawnSync(bash, ['-c', `source "${toPosix(s.path)}"; ${s.setup} APP_DIR="${toPosix(root)}"; ${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path, ...s.env, ...env },
  });
}

for (const which of ['release', 'pilot']) {
  const script = which === 'release' ? 'scripts/deploy-release.sh' : 'scripts/deploy-private-pilot.sh';
  const text = read(script);
  const check = (file) => runScript(which, `RUNTIME_ENV="${file}"; check_pgbackrest; echo "ON=$PGBACKREST_ON EXTRA=\${COMPOSE_EXTRA[*]:-}"`);

  test(`${script}: valid bash, pgBackRest step runs after postgres starts and before migrations, no timers or backups`, { skip: !bash }, () => {
    assert.equal(spawnSync(bash, ['-n', toPosix(join(root, script))], { encoding: 'utf8' }).status, 0);
    assert.match(text, /step "start postgres"; compose up -d --no-build --pull never postgres\n\s*pgbackrest_setup\n\s*run_migrations/);
    assert.match(text, /pgbackrest "--stanza=\$PGBACKREST_STANZA_VALUE" stanza-create/);
    assert.match(text, /pgbackrest "--stanza=\$PGBACKREST_STANZA_VALUE" check/);
    assert.doesNotMatch(text, /systemctl|crontab|\.timer|pgbackrest[^\n]*backup[^\n]*\|\|/);
    assert.doesNotMatch(text, /--type=full[^\n]*compose exec|compose exec[^\n]*--type=full backup\s*\|\|/);
  });

  test(`${script}: pgBackRest disabled by default adds nothing`, { skip: !bash }, () => {
    const file = runtimeEnvFile({}, { drop: KEYS });
    const r = runScript(which, `RUNTIME_ENV="${file}"; check_pgbackrest; echo "ON=$PGBACKREST_ON EXTRA=\${COMPOSE_EXTRA[*]:-}"`);
    if (which === 'release') {
      assert.notEqual(r.status, 0, 'production requires pgBackRest');
      assert.match(r.stderr, /PGBACKREST_ENABLED=true is required for production/);
    } else {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /ON=false EXTRA=\s*$/m);
      assert.match(r.stdout, /pgBackRest: disabled/);
    }
    const explicitOff = runScript(which, `RUNTIME_ENV="${runtimeEnvFile({ PGBACKREST_ENABLED: 'false' })}"; TARGET=pilot; check_pgbackrest; echo "ON=$PGBACKREST_ON EXTRA=\${COMPOSE_EXTRA[*]:-}"`);
    assert.equal(explicitOff.status, 0, explicitOff.stderr);
    assert.match(explicitOff.stdout, /ON=false EXTRA=\s*$/m);
    assert.notEqual(check(runtimeEnvFile({ PGBACKREST_ENABLED: 'yes' })).status, 0);
  });

  test(`${script}: enabled adds the overlay; missing or unsafe settings and files fail closed`, { skip: !bash }, () => {
    const ok = check(runtimeEnvFile());
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ON=true EXTRA=-f .*infrastructure\/postgres\/compose\.pgbackrest\.yml/);
    for (const key of KEYS.slice(1)) {
      const r = check(runtimeEnvFile({}, { drop: [key] }));
      assert.notEqual(r.status, 0, `${key} missing`);
      assert.match(r.stderr, new RegExp(key), key);
    }
    for (const key of ['PGBACKREST_SFTP_KEY_FILE', 'PGBACKREST_SFTP_KNOWN_HOSTS_FILE', 'PGBACKREST_CIPHER_PASS_FILE']) {
      const gone = check(runtimeEnvFile({ [key]: '/nonexistent/pgbackrest-file' }));
      assert.notEqual(gone.status, 0, key);
      assert.match(gone.stderr, new RegExp(`${key}: /nonexistent/pgbackrest-file is missing`));
      assert.match(check(runtimeEnvFile({ [key]: 'relative/file' })).stderr, new RegExp(`${key} must be an absolute host path`));
    }
    const loose = check(runtimeEnvFile({ ...hostFiles({ keyMode: 0o644 }) }));
    assert.notEqual(loose.status, 0);
    assert.match(loose.stderr, /PGBACKREST_SFTP_KEY_FILE must not be group\/world accessible/);
    assert.match(check(runtimeEnvFile({ PGBACKREST_REPO_PATH: 'repo' })).stderr, /PGBACKREST_REPO_PATH/);
    assert.match(check(runtimeEnvFile({ PGBACKREST_STANZA: 'Bad Stanza' })).stderr, /PGBACKREST_STANZA is invalid/);
    assert.match(check(runtimeEnvFile({ PGBACKREST_SFTP_PORT: 'ssh' })).stderr, /PGBACKREST_SFTP_PORT/);
  });

  test(`${script}: compose gets the overlay and stanza-create then check run as postgres after health`, { skip: !bash }, () => {
    const { bin, log } = stubDocker();
    const file = runtimeEnvFile();
    const r = runScript(which, `RUNTIME_ENV="${file}"; check_pgbackrest; HEALTH_TIMEOUT_SECONDS=5; pgbackrest_setup; compose config --quiet`, { bin });
    assert.equal(r.status, 0, r.stderr);
    const l = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const create = l.findIndex((line) => /exec -T -u postgres postgres pgbackrest --stanza=lunchlineup stanza-create/.test(line));
    const checkIdx = l.findIndex((line) => /exec -T -u postgres postgres pgbackrest --stanza=lunchlineup check/.test(line));
    assert.ok(create >= 0 && checkIdx > create, l.join('\n'));
    assert.ok(l.every((line) => /compose\.pgbackrest\.yml/.test(line) || !/^compose /.test(line)), 'every compose call carries the overlay');
    assert.match(r.stdout, /--type=full backup/);
  });

  test(`${script}: a failing stanza-create or check aborts the deploy`, { skip: !bash }, () => {
    for (const [failOn, pattern] of [['stanza-create', /pgbackrest stanza-create failed/], [' check', /pgbackrest check failed/]]) {
      const { bin } = stubDocker({ failOn });
      const r = runScript(which, `RUNTIME_ENV="${runtimeEnvFile()}"; check_pgbackrest; HEALTH_TIMEOUT_SECONDS=5; pgbackrest_setup; echo REACHED`, { bin });
      assert.notEqual(r.status, 0, failOn);
      assert.match(r.stderr, pattern);
      assert.doesNotMatch(r.stdout, /REACHED/);
    }
  });

  test(`${script}: pgbackrest_setup is a no-op when disabled`, { skip: !bash }, () => {
    const { bin, log } = stubDocker();
    const r = runScript(which, 'PGBACKREST_ON=false; pgbackrest_setup; echo DONE', { bin });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DONE/);
    assert.throws(() => readFileSync(log, 'utf8'), /ENOENT/);
  });
}

// --- env contract, docs and rules ----------------------------------------------
test('runtime env example and fixture carry the pgBackRest keys; archive hook keys are not required', () => {
  const example = read('infrastructure/production/runtime.env.example');
  for (const key of KEYS) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `${key} in runtime.env.example`);
    assert.ok(key in BASE, `${key} in the production fixture`);
  }
  assert.doesNotMatch(example, /^POSTGRES_ARCHIVE_(MODE|COMMAND)=/m);
  assert.match(example, /^# PGBACKREST_SFTP_PORT=22$/m);
});

test('docs describe the key set, fail-closed deploy, restore and estate-owned schedule', () => {
  const pgReadme = read('infrastructure/postgres/README.md');
  const runbook = read('docs/runbooks/postgres-pitr-recovery.md');
  const estate = read('docs/estate/README.md');
  for (const key of [...KEYS, 'PGBACKREST_SFTP_PORT', 'PGBACKREST_RETENTION_FULL']) assert.ok(pgReadme.includes(key), key);
  assert.match(pgReadme, /pgbackrest-egress/);
  assert.match(pgReadme, /pgbackrest=2\.\d+\.\d+-r\d+/);
  assert.match(runbook, /pgbackrest --stanza=lunchlineup --delta --type=time/);
  assert.match(runbook, /--target-action=promote restore/);
  assert.match(runbook, /--type=full backup/);
  assert.match(estate, /Backup schedule \(application\)/);
  assert.match(estate, /docker exec -u postgres/);
  assert.match(estate, /found to be unhealthy/);
  assert.match(estate, /\/var\/lib\/node_exporter\/textfile_collector/);
  assert.match(estate, /host="p1-lunchlineup-dev01"/);
  assert.doesNotMatch(estate + pgReadme + runbook, /no `pgbackrest` binary|attach(es)? through two runtime env/);
});

test('node and textfile rules select job node plus the estate host label, never instance', () => {
  const rules = read('docs/estate/lunchlineup-rules.yml');
  const selectors = [...rules.matchAll(/\{[^{}]*job="node"[^{}]*\}/g)].map((m) => m[0]);
  assert.ok(selectors.length >= 5, `expected node selectors, got ${selectors.length}`);
  for (const selector of selectors) {
    assert.match(selector, /host="p1-lunchlineup-dev01"/, selector);
    assert.doesNotMatch(selector, /instance/, selector);
  }
  assert.doesNotMatch(rules, /10\[\.\]231\[\.\]10\[\.\]108/);
  assert.match(rules, /absent\(up\{job="node",host="p1-lunchlineup-dev01"\}\)/);
});

test('autoheal logs restarts without extra flags and the compose service stays unchanged', () => {
  const autoheal = compose.slice(compose.indexOf('\n  autoheal:\n'), compose.indexOf('\nnetworks:'));
  assert.match(autoheal, /willfarrell\/autoheal@sha256:[a-f0-9]{64}/);
  assert.match(autoheal, /AUTOHEAL_CONTAINER_LABEL=all/);
  assert.doesNotMatch(autoheal, /WEBHOOK_URL|APPRISE_URL|logging: *\n *driver: none/);
  assert.match(read('docs/estate/README.md'), /Autoheal restarts in the logs/);
});

const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
test('docker compose config accepts the default stack and the stack with the pgBackRest overlay', { skip: docker.status !== 0 }, () => {
  const dir = tmp('pgbr-compose-');
  const env = { ...BASE, ...hostFiles(), PGBACKREST_SFTP_PORT: '22' };
  const envFile = join(dir, 'smoke.env');
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const base = ['compose', '-f', 'docker-compose.yml', '-f', 'infrastructure/development-admission/compose.private-proxy.yml', '--env-file', envFile, '--profile', '*'];
  const options = { cwd: root, encoding: 'utf8', env: { ...process.env, COMPOSE_SERVICE_ENV_FILE: envFile } };
  assert.equal(spawnSync('docker', [...base, 'config', '-q'], options).status, 0);
  const withOverlay = spawnSync('docker', [...base, '-f', 'infrastructure/postgres/compose.pgbackrest.yml', 'config'], options);
  assert.equal(withOverlay.status, 0, withOverlay.stderr);
  assert.match(withOverlay.stdout, /pgbackrest-egress/);
  assert.match(withOverlay.stdout, /LL_PGBR_ENABLED: "true"/);
});

// --- optional repo3 (gcs) ---------------------------------------------------------
const repo3Overlay = read('infrastructure/postgres/compose.pgbackrest-repo3.yml');
const GCS_KEY = '{"type":"service_account","project_id":"p","private_key_id":"abc","private_key":"-----BEGIN PRIVATE KEY-----\\nSECRETKEYMATERIAL\\n-----END PRIVATE KEY-----\\n","client_email":"a@p.iam.gserviceaccount.com"}\n';
const repo3Env = {
  ...enabledEnv, LL_PGBR_REPO3_ENABLED: 'true', LL_PGBR_REPO3_GCS_BUCKET: 'substance-proxmox-dr-pgbackrest',
  LL_PGBR_REPO3_PATH: '/p1-lunchlineup-dev01',
};
const repo3Files = { ...goodFiles, gcs_key: GCS_KEY, cipher_pass_repo3: 'zyxwvu9876543210\n' };

test('repo3 disabled: nothing repo3 or queue-max rendered; config has only repo2', { skip: !bash }, () => {
  const r = entrypointRun({ ...enabledEnv, LL_PGBR_REPO3_GCS_BUCKET: 'ignored-bucket' }, ['postgres'], { files: goodFiles });
  assert.equal(r.status, 0, r.stderr);
  const conf = r.conf();
  assert.match(conf, /repo2-type=sftp/);
  assert.doesNotMatch(conf, /repo3|archive-push-queue-max|gcs/);
  assert.equal(r.conf('gcs_key'), null);
  assert.match(r.stdout, /STOCK postgres -c archive_mode=on/);
  const off = entrypointRun({ ...enabledEnv, LL_PGBR_REPO3_ENABLED: 'false' }, ['postgres'], { files: goodFiles });
  assert.doesNotMatch(off.conf(), /repo3/);
});

test('repo3 enabled: gcs repository, own cipher, key copied, nothing secret printed', { skip: !bash }, () => {
  const r = entrypointRun({ ...repo3Env, LL_PGBR_ARCHIVE_PUSH_QUEUE_MAX: '4GiB' }, ['postgres'], { files: repo3Files });
  assert.equal(r.status, 0, r.stderr);
  const conf = r.conf();
  for (const line of ['repo3-type=gcs', 'repo3-path=/p1-lunchlineup-dev01', 'repo3-gcs-bucket=substance-proxmox-dr-pgbackrest',
    'repo3-gcs-key-type=service', 'repo3-retention-full-type=count', 'repo3-retention-full=2', 'repo3-retention-diff=7',
    'repo3-cipher-type=aes-256-cbc', 'repo3-cipher-pass=zyxwvu9876543210', 'archive-push-queue-max=4GiB', 'repo2-type=sftp',
    'repo2-cipher-pass=abcdef0123456789']) {
    assert.ok(conf.split('\n').includes(line), line);
  }
  assert.match(conf, /^repo3-gcs-key=.*\/gcs_key$/m);
  assert.doesNotMatch(conf, /repo3-gcs-endpoint/);
  assert.equal(r.conf('gcs_key'), GCS_KEY);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRETKEYMATERIAL|zyxwvu9876543210/);
  // repo3 lines stay inside [global], before the stanza section
  assert.ok(conf.indexOf('repo3-cipher-pass') < conf.indexOf('[lunchlineup]'));
  const custom = entrypointRun({ ...repo3Env, LL_PGBR_REPO3_RETENTION_FULL: '3', LL_PGBR_REPO3_GCS_ENDPOINT: 'localhost:4443' }, ['postgres'], { files: repo3Files });
  assert.match(custom.conf(), /^repo3-retention-full=3$/m);
  assert.match(custom.conf(), /^repo3-gcs-endpoint=localhost:4443$/m);
});

test('repo3 enabled fails closed on each missing or invalid setting and file', { skip: !bash }, () => {
  const cases = [
    ['no bucket', { LL_PGBR_REPO3_GCS_BUCKET: '' }, {}, /PGBACKREST_REPO3_GCS_BUCKET is required/],
    ['bad bucket', { LL_PGBR_REPO3_GCS_BUCKET: 'Bad_Bucket!' }, {}, /PGBACKREST_REPO3_GCS_BUCKET has an invalid value/],
    ['no path', { LL_PGBR_REPO3_PATH: '' }, {}, /PGBACKREST_REPO3_PATH is required/],
    ['relative path', { LL_PGBR_REPO3_PATH: 'lunchlineup' }, {}, /PGBACKREST_REPO3_PATH has an invalid value/],
    ['bad retention', { LL_PGBR_REPO3_RETENTION_FULL: 'x' }, {}, /PGBACKREST_REPO3_RETENTION_FULL has an invalid value/],
    ['bad endpoint', { LL_PGBR_REPO3_GCS_ENDPOINT: 'a b' }, {}, /PGBACKREST_REPO3_GCS_ENDPOINT has an invalid value/],
    ['bad queue max', { LL_PGBR_ARCHIVE_PUSH_QUEUE_MAX: 'lots' }, {}, /PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX has an invalid value/],
    ['no key file', {}, { gcs_key: undefined }, /PGBACKREST_REPO3_GCS_KEY_FILE: mounted file .* missing, empty or unreadable/],
    ['empty key file', {}, { gcs_key: '' }, /PGBACKREST_REPO3_GCS_KEY_FILE/],
    ['key is not a service account', {}, { gcs_key: '{"type":"authorized_user"}\n' }, /not a service-account JSON key/],
    ['key without private_key', {}, { gcs_key: '{"type":"service_account"}\n' }, /has no private_key/],
    ['no repo3 cipher pass', {}, { cipher_pass_repo3: undefined }, /PGBACKREST_REPO3_CIPHER_PASS_FILE/],
    ['repo3 cipher pass bad charset', {}, { cipher_pass_repo3: 'a b$c\n' }, /use only/],
    ['same passphrase as repo2', {}, { cipher_pass_repo3: 'abcdef0123456789\n' }, /must differ from PGBACKREST_CIPHER_PASS_FILE/],
  ];
  for (const [name, env, files, pattern] of cases) {
    const present = Object.fromEntries(Object.entries({ ...repo3Files, ...files }).filter(([, v]) => v !== undefined));
    const r = entrypointRun({ ...repo3Env, ...env }, ['postgres'], { files: present });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, pattern, name);
    assert.doesNotMatch(r.stdout, /STOCK/, `${name}: postgres must not start`);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETKEYMATERIAL/, name);
  }
});

test('repo3 overlay: separate file, two read-only key binds, queue cap, no network or init changes', () => {
  assert.deepEqual([...repo3Overlay.split('\nnetworks:')[0].matchAll(/^  ([a-z0-9-]+):$/gm)].map((m) => m[1]), ['postgres']);
  for (const key of ['PGBACKREST_REPO3_GCS_BUCKET', 'PGBACKREST_REPO3_PATH', 'PGBACKREST_REPO3_GCS_KEY_FILE', 'PGBACKREST_REPO3_CIPHER_PASS_FILE']) {
    assert.match(repo3Overlay, new RegExp(`\\$\\{${key}:\\?`), key);
  }
  assert.match(repo3Overlay, /LL_PGBR_REPO3_ENABLED: "true"/);
  assert.match(repo3Overlay, /target: \/run\/pgbackrest-src\/gcs_key/);
  assert.match(repo3Overlay, /target: \/run\/pgbackrest-src\/cipher_pass_repo3/);
  assert.equal([...repo3Overlay.matchAll(/read_only: true/g)].length, 2);
  assert.equal([...repo3Overlay.matchAll(/create_host_path: false/g)].length, 2);
  assert.match(repo3Overlay, /PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX:-4GiB/);
  assert.match(repo3Overlay, /PGBACKREST_REPO3_RETENTION_FULL:-2/);
  assert.doesNotMatch(stripComments(repo3Overlay), /^networks:|init:|tmpfs:/m);
  // the base overlay stays repo3-free apart from the empty-by-default queue cap
  assert.doesNotMatch(stripComments(overlay), /REPO3|gcs/i);
  assert.match(overlay, /PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX:-\}/);
});

for (const which of ['release', 'pilot']) {
  const script = which === 'release' ? 'scripts/deploy-release.sh' : 'scripts/deploy-private-pilot.sh';
  const check = (file) => runScript(which, `RUNTIME_ENV="${file}"; check_pgbackrest; echo "ON=$PGBACKREST_ON EXTRA=\${COMPOSE_EXTRA[*]:-}"`);
  const repo3Host = ({ keyMode = 0o600, key = GCS_KEY } = {}) => {
    const dir = tmp('pgbr-r3-');
    writeFileSync(join(dir, 'gcs.json'), key); chmodSync(join(dir, 'gcs.json'), keyMode);
    writeFileSync(join(dir, 'pass3'), 'zyx\n'); chmodSync(join(dir, 'pass3'), 0o600);
    return { PGBACKREST_REPO3_GCS_KEY_FILE: toPosix(join(dir, 'gcs.json')), PGBACKREST_REPO3_CIPHER_PASS_FILE: toPosix(join(dir, 'pass3')) };
  };
  const repo3Values = () => ({
    PGBACKREST_REPO3_ENABLED: 'true', PGBACKREST_REPO3_GCS_BUCKET: 'substance-proxmox-dr-pgbackrest',
    PGBACKREST_REPO3_PATH: '/p1-lunchlineup-dev01', ...repo3Host(),
  });

  test(`${script}: repo3 overlay is added only when PGBACKREST_REPO3_ENABLED=true`, { skip: !bash }, () => {
    const off = check(runtimeEnvFile());
    assert.equal(off.status, 0, off.stderr);
    const noRepo3 = /compose\.pgbackrest-repo3|repo3 \(gcs/;
    assert.doesNotMatch(off.stdout, noRepo3);
    assert.doesNotMatch(check(runtimeEnvFile({ PGBACKREST_REPO3_ENABLED: 'false', PGBACKREST_REPO3_GCS_BUCKET: 'bad!' })).stdout, noRepo3);
    const on = check(runtimeEnvFile(repo3Values()));
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /ON=true EXTRA=-f \S*compose\.pgbackrest\.yml -f \S*compose\.pgbackrest-repo3\.yml/);
    assert.match(on.stdout, /repo3 \(gcs bucket substance-proxmox-dr-pgbackrest\) enabled/);
    assert.notEqual(check(runtimeEnvFile({ PGBACKREST_REPO3_ENABLED: 'yes' })).status, 0);
  });

  test(`${script}: repo3 fails closed on each missing setting or unsafe file`, { skip: !bash }, () => {
    for (const key of ['PGBACKREST_REPO3_GCS_BUCKET', 'PGBACKREST_REPO3_PATH', 'PGBACKREST_REPO3_GCS_KEY_FILE', 'PGBACKREST_REPO3_CIPHER_PASS_FILE']) {
      const r = check(runtimeEnvFile(repo3Values(), { drop: [key] }));
      assert.notEqual(r.status, 0, key);
      assert.match(r.stderr, new RegExp(key), key);
    }
    assert.match(check(runtimeEnvFile({ ...repo3Values(), PGBACKREST_REPO3_GCS_BUCKET: 'Bad Bucket' })).stderr, /PGBACKREST_REPO3_GCS_BUCKET is invalid/);
    assert.match(check(runtimeEnvFile({ ...repo3Values(), PGBACKREST_REPO3_PATH: 'rel' })).stderr, /PGBACKREST_REPO3_PATH/);
    for (const key of ['PGBACKREST_REPO3_GCS_KEY_FILE', 'PGBACKREST_REPO3_CIPHER_PASS_FILE']) {
      const gone = check(runtimeEnvFile({ ...repo3Values(), [key]: '/nonexistent/repo3-file' }));
      assert.notEqual(gone.status, 0, key);
      assert.match(gone.stderr, new RegExp(`${key}: /nonexistent/repo3-file is missing`));
      assert.match(check(runtimeEnvFile({ ...repo3Values(), [key]: 'relative' })).stderr, new RegExp(`${key} must be an absolute host path`));
    }
    const loose = check(runtimeEnvFile({ ...repo3Values(), ...repo3Host({ keyMode: 0o644 }) }));
    assert.match(loose.stderr, /PGBACKREST_REPO3_GCS_KEY_FILE must not be group\/world accessible/);
    const notSa = check(runtimeEnvFile({ ...repo3Values(), ...repo3Host({ key: '{"type":"authorized_user"}\n' }) }));
    assert.match(notSa.stderr, /not a service-account JSON key/);
    const notJson = check(runtimeEnvFile({ ...repo3Values(), ...repo3Host({ key: 'hello\n' }) }));
    assert.match(notJson.stderr, /not a service-account JSON key/);
    const withRepo2 = runtimeEnvFile(repo3Values());
    const pass2 = readFileSync(withRepo2, 'utf8').match(/^PGBACKREST_CIPHER_PASS_FILE=(.*)$/m)[1];
    assert.match(check(runtimeEnvFile({ ...repo3Values(), PGBACKREST_REPO3_CIPHER_PASS_FILE: pass2 })).stderr, /must be a different file/);
    assert.doesNotMatch(notSa.stderr + notSa.stdout, /SECRETKEYMATERIAL|PRIVATE KEY/);
  });

  test(`${script}: stanza-create and check run once with both overlays when repo3 is enabled`, { skip: !bash }, () => {
    const { bin, log } = stubDocker();
    const r = runScript(which, `RUNTIME_ENV="${runtimeEnvFile(repo3Values())}"; check_pgbackrest; HEALTH_TIMEOUT_SECONDS=5; pgbackrest_setup`, { bin });
    assert.equal(r.status, 0, r.stderr);
    const l = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(l.filter((line) => /pgbackrest --stanza=lunchlineup stanza-create/.test(line)).length, 1);
    assert.equal(l.filter((line) => /pgbackrest --stanza=lunchlineup check/.test(line)).length, 1);
    assert.ok(l.filter((line) => /^compose /.test(line)).every((line) => /compose\.pgbackrest-repo3\.yml/.test(line)));
  });
}

test('check-production-env: repo3 keys are optional when off and required when enabled', () => {
  const errorsOf = (extra) => checkProductionEnv({ ...BASE, ...extra }, {}).filter((e) => /REPO3|PGBACKREST_\*_FILE|QUEUE_MAX|requires PGBACKREST_ENABLED/.test(e));
  assert.deepEqual(errorsOf({}), []);
  assert.deepEqual(errorsOf({ PGBACKREST_REPO3_ENABLED: 'false' }), []);
  const full = {
    PGBACKREST_REPO3_ENABLED: 'true', PGBACKREST_REPO3_GCS_BUCKET: 'substance-proxmox-dr-pgbackrest', PGBACKREST_REPO3_PATH: '/p1-lunchlineup-dev01',
    PGBACKREST_REPO3_GCS_KEY_FILE: '/opt/lunchlineup-secrets/pgbackrest/gcs_dr_key.json',
    PGBACKREST_REPO3_CIPHER_PASS_FILE: '/opt/lunchlineup-secrets/pgbackrest/repo3_cipher_pass',
  };
  assert.deepEqual(errorsOf(full), []);
  for (const key of ['PGBACKREST_REPO3_GCS_BUCKET', 'PGBACKREST_REPO3_PATH', 'PGBACKREST_REPO3_GCS_KEY_FILE', 'PGBACKREST_REPO3_CIPHER_PASS_FILE']) {
    assert.ok(errorsOf({ ...full, [key]: '' }).some((e) => e.startsWith(`${key} is required`)), key);
  }
  assert.ok(errorsOf({ ...full, PGBACKREST_REPO3_ENABLED: 'yes' }).some((e) => /must be true or false/.test(e)));
  assert.ok(errorsOf({ ...full, PGBACKREST_REPO3_GCS_BUCKET: 'Bad Bucket' }).some((e) => /valid GCS bucket/.test(e)));
  assert.ok(errorsOf({ ...full, PGBACKREST_REPO3_PATH: 'rel' }).some((e) => /absolute path prefix/.test(e)));
  assert.ok(errorsOf({ ...full, PGBACKREST_REPO3_CIPHER_PASS_FILE: BASE.PGBACKREST_CIPHER_PASS_FILE }).some((e) => /must all be different/.test(e)));
  assert.ok(errorsOf({ ...full, PGBACKREST_ENABLED: 'false' }).some((e) => /requires PGBACKREST_ENABLED=true/.test(e)));
  assert.ok(errorsOf({ PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX: 'lots' }).some((e) => /QUEUE_MAX/.test(e)));
  assert.deepEqual(errorsOf({ PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX: '4GiB' }), []);
});

test('verifyRepo3Files: off is a no-op; on checks the key parses as a service-account JSON without printing it', () => {
  const dir = tmp('pgbr-v3-');
  const file = (name, body) => { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, 0o600); return p; };
  const base = { PGBACKREST_REPO3_ENABLED: 'true', PGBACKREST_REPO3_GCS_KEY_FILE: file('k.json', GCS_KEY), PGBACKREST_REPO3_CIPHER_PASS_FILE: file('p', 'x') };
  assert.deepEqual(verifyRepo3Files({ PGBACKREST_REPO3_GCS_KEY_FILE: '/nonexistent' }), []);
  assert.deepEqual(verifyRepo3Files(base), []);
  assert.ok(verifyRepo3Files({ ...base, PGBACKREST_REPO3_GCS_KEY_FILE: join(dir, 'absent') }).some((e) => /does not exist/.test(e)));
  const notJson = verifyRepo3Files({ ...base, PGBACKREST_REPO3_GCS_KEY_FILE: file('bad', 'SECRETKEYMATERIAL') });
  assert.ok(notJson.some((e) => /not valid JSON/.test(e)));
  assert.ok(!notJson.join().includes('SECRETKEYMATERIAL'));
  assert.ok(verifyRepo3Files({ ...base, PGBACKREST_REPO3_GCS_KEY_FILE: file('au', '{"type":"authorized_user"}') }).some((e) => /not a service_account key/.test(e)));
  assert.ok(verifyRepo3Files({ ...base, PGBACKREST_REPO3_CIPHER_PASS_FILE: file('empty', '') }).some((e) => /non-empty regular file/.test(e)));
});

test('repo3 docs and example env describe the keys, egress, queue cap and schedule', () => {
  const readme = read('infrastructure/postgres/README.md');
  const example = read('infrastructure/production/runtime.env.example');
  for (const key of ['PGBACKREST_REPO3_ENABLED', 'PGBACKREST_REPO3_GCS_BUCKET', 'PGBACKREST_REPO3_PATH', 'PGBACKREST_REPO3_GCS_KEY_FILE',
    'PGBACKREST_REPO3_CIPHER_PASS_FILE', 'PGBACKREST_REPO3_RETENTION_FULL', 'PGBACKREST_REPO3_GCS_ENDPOINT', 'PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX']) {
    assert.ok(readme.includes(key), `${key} in README`);
    assert.match(example, new RegExp(`^# ${key}=`, 'm'), `${key} commented in runtime.env.example`);
  }
  assert.match(readme, /storage\.googleapis\.com/);
  assert.match(readme, /compose\.pgbackrest-repo3\.yml/);
  assert.doesNotMatch(example, /^PGBACKREST_REPO3_/m);
});

test('pgBackRest backup schedule units: per-repo timers, deploy flock, verify-only installer', { skip: !bash }, () => {
  const dir = 'infrastructure/systemd';
  const service = read(`${dir}/lunchlineup-pgbackrest-backup@.service`);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /ExecStart=\/usr\/bin\/flock -w 600 \/run\/lock\/lunchlineup-deploy\.lock \/bin\/sh \/opt\/lunchlineup\/infrastructure\/systemd\/run-pgbackrest-backup\.sh %i/);
  const expected = {
    'repo2-full': { days: ['Mon'], time: '01:10:00' },
    'repo2-diff': { days: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], time: '01:10:00' },
    'repo3-full': { days: ['Mon'], time: '02:20:00' },
    'repo3-diff': { days: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], time: '02:20:00' },
  };
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const parsed = {};
  for (const [name, want] of Object.entries(expected)) {
    const timer = read(`${dir}/lunchlineup-pgbackrest-${name}.timer`);
    assert.match(timer, new RegExp(`^Unit=lunchlineup-pgbackrest-backup@${name}\\.service$`, 'm'));
    assert.match(timer, /^Persistent=true$/m);
    assert.match(timer, /^RandomizedDelaySec=10m$/m);
    const cal = timer.match(/^OnCalendar=(.+)$/m)[1];
    const m = cal.match(/^(Mon|Mon\.\.Sun|Tue\.\.Sun) \*-\*-\* (\d\d:\d\d:\d\d) UTC$/);
    assert.ok(m, `${name}: OnCalendar ${cal} must be a weekday spec at a fixed UTC time`);
    assert.equal(m[2], want.time, name);
    const days = m[1] === 'Mon' ? ['Mon'] : dayNames.slice(dayNames.indexOf(m[1].split('..')[0]));
    assert.deepEqual(days, want.days, name);
    const [h, min] = m[2].split(':').map(Number);
    parsed[name] = { days, start: h * 60 + min };
  }
  // per repository: exactly one backup per day (full Monday, diff on the other days, never both)
  for (const repo of ['repo2', 'repo3']) {
    const all = [...parsed[`${repo}-full`].days, ...parsed[`${repo}-diff`].days].sort();
    assert.deepEqual(all, [...dayNames].sort(), `${repo}: full and diff must cover each day exactly once`);
  }
  // repo2 and repo3 never overlap: start times differ by at least 60 minutes plus the 10 minute delay
  assert.ok(parsed['repo3-full'].start - parsed['repo2-full'].start >= 70);
  assert.ok(parsed['repo3-diff'].start - parsed['repo2-diff'].start >= 70);
  // clear of the retention timers (03:17, 04:17, each +30m), the 04:00 lake runs, the 15:00 restic run and Sunday 16:00Z
  for (const { start } of Object.values(parsed)) {
    assert.ok(start + 10 < 3 * 60, 'backups finish starting before 03:00 UTC');
    assert.ok(start < 15 * 60 - 60 && start < 16 * 60, 'no Sunday-from-16:00Z or 15:00 restic collision');
  }
  assert.match(read(`${dir}/lunchlineup-retention-purge.timer`), /OnCalendar=\*-\*-\* 03:17:00/);
  const runner = join(root, dir, 'run-pgbackrest-backup.sh');
  const installer = join(root, dir, 'install-pgbackrest-schedule.sh');
  for (const s of [runner, installer]) assert.equal(spawnSync(bash, ['-n', toPosix(s)], { encoding: 'utf8' }).status, 0);
  const code = read(`${dir}/install-pgbackrest-schedule.sh`).replace(/^\s*#.*$/gm, '').replace(/echo ".*"/g, '');
  assert.deepEqual([...code.matchAll(/systemctl +(\S+)/g)].map((m) => m[1]), ['daemon-reload'], 'installer may only daemon-reload, never enable or start');
  // the runner builds the exact docker exec command and refuses repo3 when it is not enabled
  const { bin, log } = stubDocker();
  const envFile = (extra) => {
    const f = join(tmp('pgbr-run-'), 'runtime.env');
    writeFileSync(f, `${Object.entries({ PGBACKREST_ENABLED: 'true', PGBACKREST_STANZA: 'lunchlineup', ...extra }).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    return toPosix(f);
  };
  const run = (instance, file) => spawnSync(bash, [toPosix(runner), instance], { encoding: 'utf8', env: { ...process.env, PATH: `${toPosix(bin)}:${process.env.PATH}`, LUNCHLINEUP_RUNTIME_ENV: file } });
  const r3 = run('repo3-full', envFile({ PGBACKREST_REPO3_ENABLED: 'true' }));
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(readFileSync(log, 'utf8'), /exec -u postgres lunchlineup-postgres-1 pgbackrest --stanza=lunchlineup --repo=3 --type=full backup/);
  assert.notEqual(run('repo3-diff', envFile({})).status, 0);
  assert.equal(run('repo2-diff', envFile({})).status, 0);
  assert.match(readFileSync(log, 'utf8'), /pgbackrest --stanza=lunchlineup --repo=2 --type=diff backup/);
  assert.notEqual(run('repo4-full', envFile({})).status, 0);
});
