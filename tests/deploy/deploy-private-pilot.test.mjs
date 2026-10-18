import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/deploy-private-pilot.sh');
const source = readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
const bashCandidates = ['bash', 'C:\Program Files\Git\bin\bash.exe'];
const bash = bashCandidates.find((b) => spawnSync(b, ['--version']).status === 0);
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

test('script is syntactically valid bash', { skip: !bash }, () => {
  const r = spawnSync(bash, ['-n', toPosix(script)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('safety rules are present and forbidden operations are absent', () => {
  assert.match(source, /\/run\/lock\/lunchlineup-deploy\.lock/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /vm107-launch\.hold/);
  assert.match(source, /PILOT_HOST=beta\.lunchlineup\.com/);
  assert.match(source, /up -d --no-build --pull never/);
  assert.match(source, /compose\.private-proxy\.yml/);
  assert.doesNotMatch(source, /--build\b|docker system prune|volume rm|volume prune|compose down|git clean|git reset/);
  assert.doesNotMatch(source, /expir|bleaseb|cutoff|admission window/i);
});

function setup(t, { shaOverride, idOverride } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
  const archive = gzipSync(Buffer.from('not-really-a-tarball'));
  writeFileSync(join(dir, 'web.tar.gz'), archive);
  const sha = shaOverride ?? createHash('sha256').update(archive).digest('hex');
  const id = 'sha256:' + 'a'.repeat(64);
  writeFileSync(join(dir, 'web.image.json'), JSON.stringify({
    artifactName: 'web', composeServices: ['web'], imageRef: 'lunchlineup-internal-ci/web:x',
    localImageId: id, archiveFile: 'images/web.tar.gz', archiveSha256: sha, archiveBytes: archive.length,
  }));
  const bin = mkdtempSync(join(tmpdir(), 'pilot-bin-'));
  const log = join(bin, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${toPosix(log)}"
case "$1 $2" in
  "image inspect") [[ "$*" == *"{{.Id}}"* && "$*" == *"lunchlineup/web:"* ]] && exit 1; echo "${idOverride ?? id}";;
esac
cat >/dev/null 2>&1 || true
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { dir, bin, log };
}

function run(ctx) {
  const state = mkdtempSync(join(tmpdir(), 'pilot-state-'));
  const cmd = `source "${toPosix(script)}"; STATE_DIR="${toPosix(state)}"; IMAGE_TAG_VALUE=t1; load_images "${toPosix(ctx.dir)}"`;
  return spawnSync(bash, ['-c', cmd], { encoding: 'utf8', env: { ...process.env, PATH: `${toPosix(ctx.bin)}:${process.env.PATH}` } });
}

test('load_images loads, verifies the image ID and tags for compose', { skip: !bash }, (t) => {
  const ctx = setup(t);
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const log = readFileSync(ctx.log, 'utf8');
  assert.match(log, /^load$/m);
  assert.match(log, /tag sha256:a{64} lunchlineup\/web:t1/);
});

test('load_images refuses an archive sha256 mismatch before docker load', { skip: !bash }, (t) => {
  const ctx = setup(t, { shaOverride: 'b'.repeat(64) });
  const r = run(ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(existsSync(ctx.log) && /^load$/m.test(readFileSync(ctx.log, 'utf8')), false);
});

test('load_images refuses a loaded image ID mismatch and does not tag', { skip: !bash }, (t) => {
  const ctx = setup(t, { idOverride: 'sha256:' + 'c'.repeat(64) });
  const r = run(ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /loaded image ID/);
  assert.doesNotMatch(readFileSync(ctx.log, 'utf8'), /^tag /m);
});

test('private-pilot Caddyfile trusts only the CT940 proxy; production Caddyfile untouched', () => {
  const pilot = readFileSync(join(root, 'infrastructure/caddy/Caddyfile.private-pilot'), 'utf8');
  assert.match(pilot, /trusted_proxies static \{\$CADDY_TRUSTED_PROXIES:10\.231\.10\.30\/32\}/);
  assert.doesNotMatch(readFileSync(join(root, 'infrastructure/caddy/Caddyfile'), 'utf8'), /10\.231\.10\.30/);
});

function hostRefs(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-env-'));
  const env = join(dir, 'runtime.env');
  writeFileSync(env, lines.join('\n') + '\n');
  const cmd = `source "${toPosix(script)}"; RUNTIME_ENV="${toPosix(env)}"; check_host_references`;
  return spawnSync(bash, ['-c', cmd], { encoding: 'utf8' });
}

test('host guard: beta pilot passes; dev, www and apex are refused', { skip: !bash }, () => {
  const base = ['APP_ORIGIN=https://beta.lunchlineup.com', 'ALLOWED_HOSTS=beta.lunchlineup.com'];
  assert.equal(hostRefs(base).status, 0);
  assert.equal(hostRefs([...base, 'EMAIL_FROM=LunchLineup Beta <no-reply@beta.lunchlineup.com>']).status, 0);
  assert.equal(hostRefs([...base, 'EMAIL_FROM=no-reply@beta.lunchlineup.com']).status, 0);
  // Sender must be beta: dev, apex and www senders fail.
  for (const sender of ['LunchLineup Dev <no-reply@dev.lunchlineup.com>', 'LunchLineup <no-reply@lunchlineup.com>', 'x <no-reply@www.lunchlineup.com>']) {
    const r = hostRefs([...base, 'EMAIL_FROM=' + sender]);
    assert.notEqual(r.status, 0, sender);
    assert.match(r.stderr, /EMAIL_FROM must send from @beta\.lunchlineup\.com/);
  }
  // Retired dev host and production hosts fail anywhere else in the env.
  for (const line of ['APP_ORIGIN=https://dev.lunchlineup.com', 'ALLOWED_HOSTS=dev.lunchlineup.com', 'SOME_URL=https://www.lunchlineup.com/x',
    'APP_ORIGIN=https://lunchlineup.com', 'ALLOWED_HOSTS=beta.lunchlineup.com,lunchlineup.com', 'ALLOWED_HOSTS=beta.lunchlineup.com,www.lunchlineup.com']) {
    const r = hostRefs([...base, line]);
    assert.notEqual(r.status, 0, line);
    assert.match(r.stderr, /production or retired dev/, line);
  }
  assert.notEqual(hostRefs(['APP_ORIGIN=https://lunchlineup.com']).status, 0);
  assert.notEqual(hostRefs(['APP_ORIGIN=https://dev.lunchlineup.com']).status, 0);
});

test('pilot host constant is beta.lunchlineup.com', () => {
  assert.match(source, /^PILOT_HOST=beta\.lunchlineup\.com$/m);
});

test('runtime env check accepts only stripe or disabled for BILLING_PROVIDER, after the data-target check', () => {
  assert.match(source, /value="\$\(env_optional BILLING_PROVIDER\)"\n\s*\[\[ -z "\$value" \|\| "\$value" == stripe \|\| "\$value" == disabled \]\] \|\| fail "BILLING_PROVIDER must be stripe or disabled"/);
  assert.ok(source.indexOf('DATA_TARGET_ENV must be disposable, development or staging') < source.indexOf('BILLING_PROVIDER must be stripe or disabled'));
});
