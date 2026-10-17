import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/deploy-release.sh');
const source = readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
const bashCandidates = ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'];
const bash = bashCandidates.find((b) => spawnSync(b, ['--version']).status === 0);
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const SHA = 'f'.repeat(40);
const ID = 'sha256:' + 'a'.repeat(64);
const PREV = 'sha256:' + 'b'.repeat(64);

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

// Stub docker: logs argv; behaviour controlled by STUB_* env vars.
function stubBin(logName = 'docker.log') {
  const bin = tmp('rel-bin-');
  const log = join(bin, logName);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${toPosix(log)}"
case "$1 $2" in
  "image inspect")
    if [[ "$*" == *"lunchlineup/web:"* ]]; then [[ -n "\${STUB_PREV_ID:-}" ]] && { echo "$STUB_PREV_ID"; exit 0; }; exit 1; fi
    if [[ "$*" == *"$STUB_PREV_ID"* && -n "\${STUB_PREV_ID:-}" ]]; then echo "\${STUB_PREV_PRESENT:-$STUB_PREV_ID}"; exit 0; fi
    echo "\${STUB_LOADED_ID:-${ID}}"; exit 0;;
  "volume inspect") [[ "\${STUB_VOLUME:-1}" == 1 ]] && exit 0 || exit 1;;
esac
cat >/dev/null 2>&1 || true
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { bin, log };
}

function runBash(snippet, { bin, env = {} } = {}) {
  const path = bin ? `${toPosix(bin)}:${process.env.PATH}` : process.env.PATH;
  return spawnSync(bash, ['-c', `source "${toPosix(script)}"; ${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path, ...env },
  });
}

function runtimeEnv(overrides = {}, { drop = [] } = {}) {
  const base = {
    APP_ORIGIN: 'https://lunchlineup.com',
    NEXT_PUBLIC_APP_ORIGIN: 'https://lunchlineup.com',
    NEXT_PUBLIC_APP_URL: 'https://lunchlineup.com',
    ALLOWED_ORIGINS: 'https://lunchlineup.com',
    PRIVATE_APP_HOST: 'lunchlineup.com',
    DOMAIN: 'lunchlineup.com',
    ALLOWED_HOSTS: 'lunchlineup.com',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: '10.231.10.30/32',
    PROXY_HTTP_BIND: '10.231.10.120',
    PROXY_HTTP_PORT: '80',
    DATA_TARGET_ENV: 'production',
    NODE_ENV: 'production',
    MIGRATION_PRODUCTION_CONFIRM: 'apply-lunchlineup-production-migrations',
    DEPLOY_RELEASE_SHA: SHA,
    IMAGE_TAG: 'rel1',
    ...overrides,
  };
  for (const k of drop) delete base[k];
  const file = join(tmp('rel-env-'), 'runtime.env');
  writeFileSync(file, Object.entries(base).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return file;
}

const prodEnv = { PROD_BIND_IP: '10.231.10.120' };
const checkProd = (file) => runBash(`configure_target production; RUNTIME_ENV="${toPosix(file)}"; check_runtime_env; echo OK`, { env: prodEnv });

test('script is syntactically valid bash', { skip: !bash }, () => {
  const r = spawnSync(bash, ['-n', toPosix(script)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('safety rules present; forbidden operations and signing machinery absent', () => {
  assert.match(source, /\/run\/lock\/lunchlineup-deploy\.lock/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /up -d --no-build --pull never/);
  assert.match(source, /production-launch\.hold/);
  assert.match(source, /vm107-launch\.hold/);
  assert.doesNotMatch(source, /--build\b|docker system prune|volume rm|volume prune|compose down|git clean|git reset/);
  assert.doesNotMatch(source, /cosign|sigstore|oidc|attestation|admission window|expir/i);
  assert.doesNotMatch(source, /I_ACCEPT_NO_BACKUP|OFFSITE_ENABLED|compose[^\n]* run [^\n]* backup/);
});

test('pilot target keeps the pilot constants', { skip: !bash }, () => {
  const r = runBash('configure_target pilot; echo "$APP_HOST $BIND_IP $EXPECTED_HOSTNAME $OVERLAY"');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'dev.lunchlineup.com 10.231.10.108 lunchlineup-dev infrastructure/development-admission/compose.private-proxy.yml');
});

test('unknown target and missing/public production bind IP are refused', { skip: !bash }, () => {
  assert.match(runBash('configure_target staging').stderr, /--target must be pilot or production/);
  assert.match(runBash('configure_target production').stderr, /PROD_BIND_IP/);
  assert.match(runBash('configure_target production', { env: { PROD_BIND_IP: '8.8.8.8' } }).stderr, /PROD_BIND_IP/);
});

test('production runtime env: a correct env passes', { skip: !bash }, () => {
  const r = checkProd(runtimeEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

for (const [name, overrides, drop, pattern] of [
  ['dev origin', { APP_ORIGIN: 'https://dev.lunchlineup.com' }, [], /APP_ORIGIN must be exactly https:\/\/lunchlineup\.com/],
  ['beta host reference', { SOME_URL: 'https://beta.lunchlineup.com/x' }, [], /dev\/beta\/staging\/localhost/],
  ['www in allowed hosts', { ALLOWED_HOSTS: 'lunchlineup.com,www.lunchlineup.com' }, [], /ALLOWED_HOSTS must be lunchlineup\.com/],
  ['insecure cookies', { COOKIE_SECURE: 'false' }, [], /COOKIE_SECURE must be true/],
  ['blanket trust proxy', { TRUST_PROXY: 'true' }, [], /TRUST_PROXY/],
  ['wrong bind', { PROXY_HTTP_BIND: '0.0.0.0' }, [], /PROXY_HTTP_BIND/],
  ['development data target', { DATA_TARGET_ENV: 'development' }, [], /DATA_TARGET_ENV/],
  ['missing migration confirm', { MIGRATION_PRODUCTION_CONFIRM: 'yes' }, [], /MIGRATION_PRODUCTION_CONFIRM/],
  ['bad release sha', { DEPLOY_RELEASE_SHA: 'local' }, [], /DEPLOY_RELEASE_SHA/],
  ['local image tag', { IMAGE_TAG: 'local' }, [], /IMAGE_TAG/],
]) {
  test(`production runtime env refuses: ${name}`, { skip: !bash }, () => {
    const r = checkProd(runtimeEnv(overrides, { drop }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, pattern);
  });
}

test('production runtime env needs no backup or offsite keys (backups are an estate system)', { skip: !bash }, () => {
  const file = runtimeEnv({ SOME_UNRELATED_KEY: 'x' });
  const r = checkProd(file);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(source, /BACKUP_OFFSITE|offsite|backup_ok|ensure_volume_ownership|grafana|promtail/);
});

test('pilot runtime env still refuses production hosts and accepts its own', { skip: !bash }, () => {
  const good = runtimeEnv({
    APP_ORIGIN: 'https://dev.lunchlineup.com', NEXT_PUBLIC_APP_ORIGIN: 'https://dev.lunchlineup.com',
    NEXT_PUBLIC_APP_URL: 'https://dev.lunchlineup.com', ALLOWED_ORIGINS: 'https://dev.lunchlineup.com',
    PRIVATE_APP_HOST: 'dev.lunchlineup.com', DOMAIN: 'dev.lunchlineup.com', ALLOWED_HOSTS: 'dev.lunchlineup.com',
    PROXY_HTTP_BIND: '10.231.10.108', DATA_TARGET_ENV: 'development',
  });
  const run = (f) => runBash(`configure_target pilot; RUNTIME_ENV="${toPosix(f)}"; check_runtime_env; echo OK`);
  assert.equal(run(good).status, 0, run(good).stderr);
  const bad = runtimeEnv({ DATA_TARGET_ENV: 'production' });
  assert.notEqual(run(bad).status, 0);
});

test('production host check refuses a launch hold', { skip: !bash }, () => {
  const holdDir = tmp('rel-hold-');
  const hold = join(holdDir, 'production-launch.hold');
  writeFileSync(hold, 'hold');
  const r = runBash(`configure_target production; HOLD_FILES=("${toPosix(hold)}"); id() { echo 0; }; hostname() { echo lunchlineup-prod; }; ` +
    'APP_DIR=/opt/lunchlineup; check_host', { env: prodEnv });
  assert.notEqual(r.status, 0);
  // Either the checkout is absent in this sandbox or the hold fires; the hold must never be silently ignored.
  assert.match(r.stderr, /launch hold present|APP_DIR must be|overlay missing/);
});

test('production host check refuses a wrong hostname', { skip: !bash }, () => {
  const r = runBash('configure_target production; id() { echo 0; }; hostname() { echo lunchlineup-dev; }; check_host', { env: prodEnv });
  assert.match(r.stderr, /this is not lunchlineup-prod/);
});

function archiveDir() {
  const dir = tmp('rel-img-');
  const archive = gzipSync(Buffer.from('not-really-a-tarball'));
  writeFileSync(join(dir, 'web.tar.gz'), archive);
  writeFileSync(join(dir, 'web.image.json'), JSON.stringify({
    artifactName: 'web', composeServices: ['web'], imageRef: 'lunchlineup-internal-ci/web:x', localImageId: ID,
    archiveFile: 'images/web.tar.gz', archiveSha256: createHash('sha256').update(archive).digest('hex'), archiveBytes: archive.length,
  }));
  return dir;
}

test('load_images keeps the previous image for rollback and records it', { skip: !bash }, () => {
  const { bin, log } = stubBin();
  const state = tmp('rel-state-');
  const r = runBash(`configure_target production; STATE_DIR="${toPosix(state)}"; IMAGE_TAG_VALUE=rel1; RELEASE_ID=20261101T000000Z-rel1; load_images "${toPosix(archiveDir())}"; printf %s "$IMAGE_RECORDS"`,
    { bin, env: { ...prodEnv, STUB_PREV_ID: PREV } });
  assert.equal(r.status, 0, r.stderr);
  const l = readFileSync(log, 'utf8');
  assert.match(l, new RegExp(`tag ${PREV} lunchlineup-rollback/web:previous`));
  assert.match(l, new RegExp(`tag ${PREV} lunchlineup-rollback/web:before-20261101T000000Z-rel1`));
  assert.match(l, new RegExp(`tag ${ID} lunchlineup/web:rel1`));
  assert.match(r.stdout, new RegExp(`web\\tlunchlineup/web:rel1\\t${ID}\\t[a-f0-9]{64}\\t${PREV}`));
});

test('load_images refuses sha256 and image-ID mismatches', { skip: !bash }, () => {
  const { bin, log } = stubBin();
  const dir = archiveDir();
  const meta = JSON.parse(readFileSync(join(dir, 'web.image.json'), 'utf8'));
  meta.archiveSha256 = 'b'.repeat(64);
  writeFileSync(join(dir, 'web.image.json'), JSON.stringify(meta));
  const state = tmp('rel-state-');
  const snippet = (d) => `configure_target production; STATE_DIR="${toPosix(state)}"; IMAGE_TAG_VALUE=rel1; load_images "${toPosix(d)}"`;
  const r = runBash(snippet(dir), { bin, env: prodEnv });
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(existsSync(log) && /^load$/m.test(readFileSync(log, 'utf8')), false);
  const r2 = runBash(snippet(archiveDir()), { bin, env: { ...prodEnv, STUB_LOADED_ID: 'sha256:' + 'c'.repeat(64) } });
  assert.match(r2.stderr, /loaded image ID/);
});

test('production with no postgres volume refuses unless this is declared the first install', { skip: !bash }, () => {
  const { bin } = stubBin();
  const env = { ...prodEnv, STUB_VOLUME: '0' };
  const snippet = 'configure_target production; RUNTIME_ENV=/dev/null; check_existing_database';
  assert.match(runBash(snippet, { bin, env }).stderr, /no postgres volume on production/);
  assert.equal(runBash(snippet, { bin, env: { ...env, DEPLOY_FIRST_INSTALL: 'yes' } }).status, 0);
});

test('receipt records sha, image IDs, migrations and timestamps and no backup proof', { skip: !bash }, () => {
  const app = tmp('rel-app-');
  mkdirSync(join(app, 'packages/db/prisma/migrations/20260101_init'), { recursive: true });
  writeFileSync(join(app, 'packages/db/prisma/migrations/20260101_init/migration.sql'), 'select 1;');
  writeFileSync(join(app, 'packages/db/prisma/migrations/20261004_extra.sql'), 'select 1;');
  const state = tmp('rel-state-');
  const r = runBash(`configure_target production; APP_DIR="${toPosix(app)}"; STATE_DIR="${toPosix(state)}"; IMAGE_TAG_VALUE=rel1; RELEASE_SHA_VALUE=${SHA}; ` +
    `IMAGE_RECORDS=$'web\\tlunchlineup/web:rel1\\t${ID}\\t${'d'.repeat(64)}\\t${PREV}\\n'; begin_receipt; write_receipt ok; echo "$RECEIPT_DIR"`,
    { env: prodEnv });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(readFileSync(join(r.stdout.trim(), 'receipt.json'), 'utf8'));
  assert.equal(doc.status, 'ok');
  assert.equal(doc.target, 'production');
  assert.equal(doc.origin, 'https://lunchlineup.com');
  assert.equal(doc.releaseSha, SHA);
  assert.equal(doc.images[0].imageId, ID);
  assert.equal(doc.images[0].previousImageId, PREV);
  assert.ok(doc.migrations.includes('20260101_init') && doc.migrations.includes('20261004_extra.sql'));
  assert.equal(doc.preDeployBackup, undefined);
  assert.match(doc.startedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(doc.finishedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
});

test('rollback_images retags the recorded previous IDs and refuses missing ones', { skip: !bash }, () => {
  const state = tmp('rel-state-');
  const rid = '20261101T000000Z-rel1';
  mkdirSync(join(state, 'receipts', rid), { recursive: true });
  writeFileSync(join(state, 'receipts', rid, 'receipt.json'), JSON.stringify({
    images: [{ name: 'web', composeRef: 'lunchlineup/web:rel1', imageId: ID, previousImageId: PREV }],
  }));
  const { bin, log } = stubBin();
  const snippet = `configure_target production; STATE_DIR="${toPosix(state)}"; APP_DIR=/x; RUNTIME_ENV=/dev/null; wait_for_health() { :; }; rollback_images ${rid}`;
  const ok = runBash(snippet, { bin, env: { ...prodEnv, STUB_PREV_ID: PREV } });
  assert.equal(ok.status, 0, ok.stderr);
  const l = readFileSync(log, 'utf8');
  assert.match(l, new RegExp(`tag ${PREV} lunchlineup/web:rel1`));
  assert.match(l, /up -d --no-build --pull never/);
  assert.doesNotMatch(l, /migrate|backup|down|volume rm/);
  const gone = runBash(snippet, { bin, env: { ...prodEnv, STUB_PREV_ID: PREV, STUB_PREV_PRESENT: 'sha256:' + '0'.repeat(64) } });
  assert.match(gone.stderr, /no longer present/);
});

test('production overlay and Caddyfile: private bind, trusted CT940 only, no dev/beta host, estate metrics gateway, no backup service', () => {
  const overlay = readFileSync(join(root, 'infrastructure/production/compose.production-proxy.yml'), 'utf8');
  assert.match(overlay, /PROXY_HTTP_BIND/);
  assert.match(overlay, /CADDY_SITE_ADDRESSES: http:\/\/lunchlineup\.com\s/);
  assert.match(overlay, /Caddyfile\.production/);
  assert.match(overlay, /target: 9180\s+published: "9180"/);
  assert.doesNotMatch(overlay, /backup|OFFSITE|dev\.lunchlineup|beta\.lunchlineup|0\.0\.0\.0/);
  const caddy = readFileSync(join(root, 'infrastructure/caddy/Caddyfile.production'), 'utf8');
  assert.match(caddy, /trusted_proxies static 10\.231\.10\.30\/32/);
  assert.match(caddy, /trusted_proxies_strict/);
  assert.doesNotMatch(caddy, /dev\.lunchlineup|beta\.lunchlineup|www\.lunchlineup/);
  assert.match(caddy, /Strict-Transport-Security/);
});
