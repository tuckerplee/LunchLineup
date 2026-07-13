import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = process.env.GIT || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

function trackedFiles() {
  return execFileSync(git, ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'));
}

function untrackedFiles() {
  return execFileSync(git, ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'));
}

function repositoryFiles() {
  return [...new Set([...trackedFiles(), ...untrackedFiles()])].sort();
}

function isGeneratedArtifact(file) {
  const segments = file.split('/');

  return (
    file === '.coverage' ||
    file.endsWith('/.coverage') ||
    segments.includes('.next') ||
    segments.includes('__pycache__') ||
    segments.includes('coverage') ||
    segments.includes('dist') ||
    /\.(py[cod]|tsbuildinfo)$/.test(file)
  );
}

function isOversizedSourceCandidate(file) {
  const segments = file.split('/');
  if (isGeneratedArtifact(file)) return false;
  if (!['apps', 'packages'].includes(segments[0])) return false;
  if (file.endsWith('.d.ts')) return false;
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(file)) return false;
  return /\.(ts|tsx|py|prisma)$/.test(file);
}

function lineCount(path) {
  return read(path).split(/\r?\n/).length;
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function directoryOf(file) {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

function trackedSiblingEntries(readme, files) {
  const directory = directoryOf(readme);
  const entries = new Set();

  for (const file of files) {
    if (file.startsWith('old/')) continue;

    const relativePath = directory ? file.slice(directory.length + 1) : file;
    if (directory && !file.startsWith(`${directory}/`)) continue;
    if (!relativePath || relativePath.startsWith('../')) continue;

    const [first, ...rest] = relativePath.split('/');
    entries.add(rest.length ? `${first}/` : first);
  }

  return [...entries].sort();
}

function readmeInventoryTokens(markdown) {
  const withoutFencedBlocks = markdown.replace(/```[\s\S]*?```/g, '');
  return new Set([...withoutFencedBlocks.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].replaceAll('\\', '/')));
}

function entryIsDocumented(entry, tokens) {
  if (tokens.has(entry)) return true;

  if (entry.endsWith('/')) {
    const directory = entry.slice(0, -1);
    return tokens.has(directory) || [...tokens].some((token) => token.startsWith(entry));
  }

  return false;
}

test('repository does not track deploy secrets or local environment files', () => {
  const forbidden = trackedFiles().filter((file) => {
    if (file.endsWith('.env.example')) return false;
    return (
      /(^|\/)\.env(\.|$)/.test(file) ||
      /^secrets\//.test(file) ||
      /\.(pem|key)$/.test(file)
    );
  });

  assert.deepEqual(forbidden, [], `Tracked secret-like files: ${forbidden.join(', ')}`);
});

test('legacy public backup directory contains no backup payloads', () => {
  const backupFiles = trackedFiles().filter((file) => file.startsWith('old/public/backups/'));
  const allowed = new Set(['old/public/backups/.gitignore', 'old/public/backups/README.md']);
  const payloads = backupFiles.filter((file) => !allowed.has(file));

  assert.deepEqual(payloads, [], `Tracked public backup payloads: ${payloads.join(', ')}`);
});

test('root ignore rules cover generated and sensitive rebuild artifacts', () => {
  const gitignore = read('.gitignore');
  const dockerignore = read('.dockerignore');
  for (const expected of [
    '.env',
    '.env.local',
    'secrets/',
    'node_modules/',
    'apps/web/.next/',
    'apps/*/dist/',
    'packages/*/dist/',
    '*.tsbuildinfo',
    '__pycache__/',
    '*.py[cod]',
    '.coverage',
    'coverage/',
    'playwright-report/',
    'test-results/',
    'apps/web/playwright-report/',
    'apps/web/test-results/',
    '.turbo/',
    '*.log',
  ]) {
    assert.match(gitignore, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const expected of [
    '.env',
    'secrets/',
    '__pycache__/',
    '*.py[cod]',
    '.coverage',
    'coverage/',
    'playwright-report',
    'test-results',
    'apps/web/playwright-report/',
    'apps/web/test-results/',
  ]) {
    assert.match(dockerignore, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('CI runs migration hygiene before build and deploy stages', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /npm run test:migration/);
  assert.match(ci, /github\.sha/);
});

test('CI gates release images on the worker Python unit suite', () => {
  const ci = read('.github/workflows/ci.yml');
  const unitJob = ci.indexOf('unit-tests:');
  const requirements = ci.indexOf('pip install -r apps/worker/requirements.txt', unitJob);
  const workerTests = ci.indexOf('python -m unittest discover -s apps/worker/tests', unitJob);
  const buildJob = ci.indexOf('build-images:');

  assert.ok(unitJob >= 0 && requirements > unitJob);
  assert.ok(workerTests > requirements);
  assert.ok(buildJob > workerTests);
  assert.match(ci, /build-images:[\s\S]*needs: unit-tests/);
});

test('Prometheus uses the protected metrics token secret', () => {
  const compose = read('docker-compose.yml');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');

  assert.match(compose, /metrics_token:/);
  assert.match(compose, /METRICS_TOKEN_FILE=\/run\/secrets\/metrics_token/);
  assert.match(prometheus, /credentials_file:\s*\/run\/secrets\/metrics_token/);
});

test('Caddy applies public SaaS browser and API cache hardening headers', () => {
  const caddy = read('infrastructure/caddy/Caddyfile');
  const template = read('infrastructure/caddy/Caddyfile.template');
  const nextConfig = read('apps/web/next.config.js');

  for (const config of [caddy, template]) {
    assert.match(config, /Content-Security-Policy .*script-src-attr 'none'/);
    assert.match(config, /script-src 'self' https:\/\/challenges\.cloudflare\.com 'unsafe-inline'/);
    assert.match(config, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(config, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(config, /Cross-Origin-Opener-Policy "same-origin"/);
    assert.match(config, /Cross-Origin-Resource-Policy "same-origin"/);
    assert.match(config, /header \/api\/\* Cache-Control "no-store"/);
    assert.doesNotMatch(config, /Access-Control-Allow-Origin "\*"/);
  }

  assert.match(nextConfig, /script-src 'self' \$\{turnstileOrigin\} 'unsafe-inline'/);
  assert.match(nextConfig, /frame-src 'self' \$\{turnstileOrigin\}/);
  assert.match(nextConfig, /connect-src 'self' \$\{turnstileOrigin\}/);
});

test('example environment avoids unsafe broker defaults', () => {
  const envExample = read('.env.example');

  assert.doesNotMatch(envExample, /^RABBITMQ_USER=guest$/m);
  assert.doesNotMatch(envExample, /^RABBITMQ_PASSWORD=guest$/m);
});

test('Compose app services consume validated encoded container-local database URLs', () => {
  const compose = read('docker-compose.yml');

  assert.match(compose, /api:[\s\S]*DATABASE_URL=\$\{DATABASE_URL:\?Set validated percent-encoded DATABASE_URL in \.env\}/);
  assert.match(compose, /worker:[\s\S]*DATABASE_URL=\$\{DATABASE_URL:\?Set validated percent-encoded DATABASE_URL in \.env\}/);
  assert.match(compose, /migrate:[\s\S]*MIGRATION_DATABASE_URL=\$\{MIGRATION_DATABASE_URL:\?Set validated percent-encoded MIGRATION_DATABASE_URL in \.env\}/);
  assert.doesNotMatch(compose, /(?:DATABASE_URL|MIGRATION_DATABASE_URL|RABBITMQ_URL)=(?:postgres|postgresql|amqp):\/\/\$\{/);
  assert.doesNotMatch(compose, /DATABASE_URL=.*@localhost:5432/);
});

test('GitHub Actions execute external actions only by immutable commit SHA', () => {
  const workflow = read('.github/workflows/ci.yml');
  const references = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('./'));
  const unpinned = references.filter((reference) => !/@[a-f0-9]{40}$/i.test(reference));

  assert.deepEqual(unpinned, [], `External GitHub Actions must be SHA-pinned:\n${unpinned.join('\n')}`);
});

test('folder-level documentation covers the migration test files', () => {
  const readme = read('tests/README.md');
  for (const expected of [
    'hygiene/repository-hygiene.test.mjs',
    'migration/legacy-parity-inventory.test.mjs',
    'deploy/deploy-source.test.mjs',
    'integration/ephemeral-stack.test.mjs',
  ]) {
    assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('project README inventories cover tracked and untracked sibling files', () => {
  const files = repositoryFiles().filter((file) => !file.startsWith('old/') && !isGeneratedArtifact(file));
  const readmes = files.filter((file) => file === 'README.md' || file.endsWith('/README.md'));
  const missing = [];

  for (const readme of readmes) {
    const tokens = readmeInventoryTokens(read(readme));
    for (const entry of trackedSiblingEntries(readme, files)) {
      if (!entryIsDocumented(entry, tokens)) {
        missing.push(`${readme} missing \`${entry}\``);
      }
    }
  }

  assert.deepEqual(missing, [], `README inventory drift:\n${missing.map((item) => `- ${item}`).join('\n')}`);
});

test('oversized public SaaS source files are documented as code-organization hotspots', () => {
  const docs = read('docs/code-organization.md');
  const oversized = repositoryFiles()
    .filter(isOversizedSourceCandidate)
    .filter((file) => existsSync(join(root, file)))
    .filter((file) => lineCount(file) > 500);

  const undocumented = oversized.filter((file) => !docs.includes(`\`${file}\``));

  assert.deepEqual(
    undocumented,
    [],
    `Oversized source files must be listed in docs/code-organization.md:\n${undocumented.map((item) => `- ${item}`).join('\n')}`,
  );
});
