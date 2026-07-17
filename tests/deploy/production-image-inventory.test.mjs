import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { deriveProductionImageInventory } from '../../scripts/production-image-inventory.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const releaseServices = ['api', 'web', 'engine', 'worker', 'migrate', 'control', 'backup'];

function releaseManifest() {
  return {
    sourceSha,
    images: Object.fromEntries(releaseServices.map((service, index) => {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      return [service, { ref: `ghcr.io/tuckerplee/lunchlineup/${service}:${sourceSha}@${digest}`, digest }];
    })),
  };
}

test('production image inventory covers every Compose image without a second hard-coded CI list', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-production-images-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  try {
    writeFileSync(manifestPath, `${JSON.stringify(releaseManifest())}\n`);
    const inventory = deriveProductionImageInventory({ manifestPath });
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const composeServices = Object.keys(parse(compose, { merge: true }).services);
    const coveredServices = inventory.images.flatMap(({ composeServices: services }) => services).sort();
    assert.deepEqual(coveredServices, composeServices.sort());
    assert.equal(new Set(inventory.images.map(({ ref }) => ref)).size, inventory.images.length);
    for (const image of inventory.images) assert.match(image.ref, /@sha256:[a-f0-9]{64}$/);

    const byService = new Map(inventory.images.flatMap((image) => image.composeServices.map((service) => [service, image])));
    for (const service of [
      'proxy', 'pgbouncer', 'postgres', 'redis', 'rabbitmq', 'prometheus', 'alertmanager',
      'grafana', 'loki', 'tempo', 'autoheal', 'node-exporter', 'promtail', 'otel-collector',
    ]) assert.equal(byService.get(service)?.source, 'compose', `${service} must be a scanned third-party image`);
    for (const service of releaseServices) assert.equal(byService.get(service)?.source, 'release-manifest');

    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /production-image-inventory\.mjs --manifest \.release\/release-manifest\.json --github-matrix-output/);
    assert.equal((ci.match(/fromJSON\(needs\.production-image-inventory\.outputs\.matrix\)/g) ?? []).length, 2);
    assert.doesNotMatch(ci, /service: \[api, web, engine, worker, migrate, control, backup\]/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production image inventory rejects a mutable third-party Compose image', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-mutable-production-image-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const composePath = join(scratch, 'docker-compose.yml');
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ sourceSha, images: {} })}\n`);
    writeFileSync(composePath, 'services:\n  postgres:\n    image: postgres:16-alpine\n');
    assert.throws(
      () => deriveProductionImageInventory({ manifestPath, composePath }),
      /image must be a literal digest or a release-manifest image/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production image inventory parses quoted and underscore services, inline mappings, indentation, and inherited third-party images', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-parsed-production-images-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const composePath = join(scratch, 'docker-compose.yml');
  const sharedDigest = `sha256:${'a'.repeat(64)}`;
  const inlineDigest = `sha256:${'b'.repeat(64)}`;
  const newDigest = `sha256:${'c'.repeat(64)}`;
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ sourceSha, images: {} })}\n`);
    writeFileSync(composePath, [
      `x-shared: &shared`,
      `    image: "vendor/shared@${sharedDigest}"`,
      `services:`,
      `    "quoted-service":`,
      `        <<: *shared`,
      `    under_score: { image: 'vendor/inline@${inlineDigest}' }`,
      `    inherited_again:`,
      `        <<: *shared`,
      `    new-third-party:`,
      `        image: vendor/new@${newDigest}`,
      '',
    ].join('\n'));

    const inventory = deriveProductionImageInventory({ manifestPath, composePath });
    const byService = new Map(inventory.images.flatMap((image) => image.composeServices.map((service) => [service, image])));
    assert.deepEqual([...byService.keys()].sort(), ['inherited_again', 'new-third-party', 'quoted-service', 'under_score']);
    assert.equal(byService.get('quoted-service'), byService.get('inherited_again'));
    assert.equal(byService.get('under_score')?.ref, `vendor/inline@${inlineDigest}`);
    assert.equal(byService.get('new-third-party')?.source, 'compose');
    assert.equal(inventory.images.length, 3, 'shared inherited images are scanned once');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production image inventory fails when any production service omits its resolved image', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-missing-production-image-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const composePath = join(scratch, 'docker-compose.yml');
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ sourceSha, images: {} })}\n`);
    writeFileSync(composePath, [
      'services:',
      '  complete: { image: "vendor/complete@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }',
      '  omitted:',
      '    environment: []',
      '',
    ].join('\n'));
    assert.throws(
      () => deriveProductionImageInventory({ manifestPath, composePath }),
      /service "omitted" must resolve exactly one non-empty image/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production image inventory rejects duplicate image keys instead of choosing one', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-duplicate-production-image-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const composePath = join(scratch, 'docker-compose.yml');
  try {
    writeFileSync(manifestPath, `${JSON.stringify({ sourceSha, images: {} })}\n`);
    writeFileSync(composePath, [
      'services:',
      '  duplicate:',
      '    image: vendor/one@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '    image: vendor/two@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '',
    ].join('\n'));
    assert.throws(
      () => deriveProductionImageInventory({ manifestPath, composePath }),
      /valid YAML with unique mapping keys/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
