import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectReleaseEvidence,
  validateImmutableRelease,
} from '../../scripts/publish-release-evidence.mjs';
import { emitCandidateEvidence } from '../../scripts/launch-proof-evidence.mjs';
import { deriveProductionImageInventory } from '../../scripts/production-image-inventory.mjs';

const services = ['api', 'web', 'engine', 'worker', 'migrate', 'control', 'backup'];
const sourceSha = '0123456789abcdef0123456789abcdef01234567';

test('immutable release evidence contains signed image reports and exact candidate raw bundles', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-release-evidence-'));
  const sbomDir = join(scratch, 'sbom');
  const trivyDir = join(scratch, 'trivy');
  const dastDir = join(scratch, 'dast');
  const loadDir = join(scratch, 'load');
  const manifestPath = join(scratch, 'release-manifest.json');
  const zapImage = `zaproxy/zaproxy:stable@sha256:${'a'.repeat(64)}`;
  const artilleryImage = `artilleryio/artillery:2.0.33@sha256:${'b'.repeat(64)}`;
  try {
    mkdirSync(sbomDir);
    mkdirSync(trivyDir);
    mkdirSync(dastDir);
    mkdirSync(loadDir);
    const images = Object.fromEntries(services.map((service, index) => {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      return [service, { ref: `ghcr.io/tuckerplee/lunchlineup/${service}:${sourceSha}@${digest}`, digest }];
    }));
    writeFileSync(manifestPath, `${JSON.stringify({ sourceSha, images })}\n`);
    const inventory = deriveProductionImageInventory({ manifestPath });
    for (const { name: service } of inventory.images) {
      for (const suffix of ['spdx.json', 'sbom-evidence.json', 'sbom-evidence.sigstore.json']) {
        writeFileSync(join(sbomDir, `${service}.${suffix}`), `{"service":"${service}","kind":"${suffix}"}\n`);
      }
      for (const suffix of ['trivy.json', 'trivy-evidence.json', 'trivy-evidence.sigstore.json']) {
        writeFileSync(join(trivyDir, `${service}.${suffix}`), `{"service":"${service}","kind":"${suffix}"}\n`);
      }
    }

    const dastJson = join(dastDir, `dast-zap-${sourceSha}.json`);
    const dastHtml = join(dastDir, `dast-zap-${sourceSha}.html`);
    const loadArtillery = join(loadDir, `load-artillery-${sourceSha}.json`);
    const loadAvailability = join(loadDir, `load-availability-${sourceSha}.json`);
    writeFileSync(dastJson, '{"site":[{"alerts":[]}]}\n');
    writeFileSync(dastHtml, '<!doctype html><title>ZAP report</title>\n');
    writeFileSync(loadArtillery, '{"aggregate":{"counters":{"http.requests":4,"http.codes.200":4,"vusers.failed":0},"summaries":{"http.response_time":{"p99":25}}}}\n');
    writeFileSync(loadAvailability, '{"status":"passed","requestCount":2}\n');
    const common = {
      'source-sha': sourceSha,
      'target-url': 'https://lunchlineup.example',
      'served-release-sha': sourceSha,
      'command-exit-code': '0',
      command: 'candidate evidence command',
    };
    const dastEvidence = emitCandidateEvidence('dast', {
      ...common,
      'tool-image': zapImage,
      'raw-report': dastJson,
      'raw-html': dastHtml,
    });
    const loadEvidence = emitCandidateEvidence('load', {
      ...common,
      'tool-image': artilleryImage,
      'raw-result': loadArtillery,
      'availability-result': loadAvailability,
    });
    writeFileSync(join(dastDir, `dast-evidence-${sourceSha}.json`), `${JSON.stringify(dastEvidence)}\n`);
    writeFileSync(join(loadDir, `load-evidence-${sourceSha}.json`), `${JSON.stringify(loadEvidence)}\n`);

    const collectOptions = {
      manifestPath,
      sbomDir,
      trivyDir,
      dastDir,
      loadDir,
      sourceSha,
      zapImage,
      artilleryImage,
    };

    const assets = collectReleaseEvidence(collectOptions);
    assert.equal(assets.length, 1 + inventory.images.length * 6 + 6);
    for (const path of [dastJson, dastHtml, loadArtillery, loadAvailability]) {
      const asset = assets.find((entry) => entry.name === path.split(/[\\/]/).at(-1));
      assert.ok(asset, `missing raw release asset ${path}`);
      assert.equal(asset.digest, `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
    const release = {
      tag_name: `release-evidence-${sourceSha}`,
      target_commitish: sourceSha,
      draft: false,
      prerelease: true,
      immutable: true,
    };
    const remoteAssets = assets.map((asset) => ({
      name: asset.name,
      state: 'uploaded',
      size: asset.size,
      digest: asset.digest,
    }));
    assert.doesNotThrow(() => validateImmutableRelease(release, remoteAssets, assets, sourceSha));
    assert.throws(
      () => validateImmutableRelease({ ...release, immutable: false }, remoteAssets, assets, sourceSha),
      /immutable source-bound contract/,
    );
    assert.throws(
      () => validateImmutableRelease(
        release,
        remoteAssets.map((asset, index) => index === 0 ? { ...asset, digest: 'sha256:' + '0'.repeat(64) } : asset),
        assets,
        sourceSha,
      ),
      /does not match local bytes/,
    );

    rmSync(join(sbomDir, 'api.sbom-evidence.sigstore.json'));
    assert.throws(
      () => collectReleaseEvidence(collectOptions),
      /Release evidence asset/,
    );
    writeFileSync(join(sbomDir, 'api.sbom-evidence.sigstore.json'), '{"restored":true}\n');
    writeFileSync(dastHtml, '<!doctype html><title>Tampered</title>\n');
    assert.throws(() => collectReleaseEvidence(collectOptions), /downloaded raw file/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
