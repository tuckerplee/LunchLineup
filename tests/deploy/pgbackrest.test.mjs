import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
  chmodSync(join(bin, 'id'), 0o755);
  chmodSync(join(bin, 'docker-entrypoint.sh'), 0o755);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  return spawnSync(bash, [toPosix(entrypoint), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${toPosix(bin)}:${process.env.PATH}`, LL_PGBR_RUNTIME_DIR: toPosix(dest), LL_PGBR_SOURCE_DIR: toPosix(src), ...env },
  });
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
  assert.match(estate, /Backup schedule \(estate-infra\)/);
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
