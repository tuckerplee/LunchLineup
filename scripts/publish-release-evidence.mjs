#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCandidateEvidenceBundle } from './launch-proof-evidence.mjs';
import { deriveProductionImageInventory } from './production-image-inventory.mjs';

const apiVersion = '2022-11-28';

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAsset(path) {
  const resolved = resolve(path);
  let stat;
  let bytes;
  try {
    stat = statSync(resolved);
    bytes = readFileSync(resolved);
  } catch {
    fail(`Release evidence asset is missing or unreadable: ${resolved}`);
  }
  if (!stat.isFile() || stat.size < 1) fail(`Release evidence asset must be a non-empty file: ${resolved}`);
  return {
    name: basename(resolved),
    path: resolved,
    bytes,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
  };
}

export function collectReleaseEvidence({
  manifestPath,
  sbomDir,
  trivyDir,
  dastDir,
  loadDir,
  sourceSha,
  zapImage,
  artilleryImage,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('Release evidence source SHA must be a full lowercase Git SHA.');
  const manifest = readAsset(manifestPath);
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifest.bytes.toString('utf8'));
  } catch {
    fail('Release evidence manifest must contain JSON.');
  }
  if (manifestValue?.sourceSha !== sourceSha) fail('Release evidence manifest sourceSha does not match the requested release.');
  const inventory = deriveProductionImageInventory({ manifestPath });

  const assets = [manifest];
  for (const { name: service } of inventory.images) {
    for (const suffix of ['spdx.json', 'sbom-evidence.json', 'sbom-evidence.sigstore.json']) {
      assets.push(readAsset(join(sbomDir, `${service}.${suffix}`)));
    }
    for (const suffix of ['trivy.json', 'trivy-evidence.json', 'trivy-evidence.sigstore.json']) {
      assets.push(readAsset(join(trivyDir, `${service}.${suffix}`)));
    }
  }
  const candidatePaths = {
    dastEvidence: join(dastDir, `dast-evidence-${sourceSha}.json`),
    dastJson: join(dastDir, `dast-zap-${sourceSha}.json`),
    dastHtml: join(dastDir, `dast-zap-${sourceSha}.html`),
    loadEvidence: join(loadDir, `load-evidence-${sourceSha}.json`),
    loadArtillery: join(loadDir, `load-artillery-${sourceSha}.json`),
    loadAvailability: join(loadDir, `load-availability-${sourceSha}.json`),
  };
  verifyCandidateEvidenceBundle('dast', {
    evidence: candidatePaths.dastEvidence,
    'raw-report': candidatePaths.dastJson,
    'raw-html': candidatePaths.dastHtml,
    'expected-source-sha': sourceSha,
    'expected-tool-image': zapImage,
    'max-age-seconds': 14400,
  });
  verifyCandidateEvidenceBundle('load', {
    evidence: candidatePaths.loadEvidence,
    'raw-result': candidatePaths.loadArtillery,
    'availability-result': candidatePaths.loadAvailability,
    'expected-source-sha': sourceSha,
    'expected-tool-image': artilleryImage,
    'max-age-seconds': 14400,
  });
  for (const path of Object.values(candidatePaths)) assets.push(readAsset(path));
  const names = assets.map((asset) => asset.name);
  if (new Set(names).size !== names.length) fail('Release evidence asset names must be unique.');
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

export function validateImmutableRelease(release, remoteAssets, expectedAssets, sourceSha) {
  const tag = `release-evidence-${sourceSha}`;
  if (
    release?.tag_name !== tag
    || release?.target_commitish !== sourceSha
    || release?.draft !== false
    || release?.prerelease !== true
    || release?.immutable !== true
  ) fail('Published release evidence does not use the immutable source-bound contract.');

  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]));
  if (!Array.isArray(remoteAssets) || remoteAssets.length !== expectedByName.size) {
    fail('Immutable release evidence asset count does not match the local report set.');
  }
  for (const remote of remoteAssets) {
    const expected = expectedByName.get(remote?.name);
    if (!expected || remote?.state !== 'uploaded' || remote?.size !== expected.size || remote?.digest !== expected.digest) {
      fail(`Immutable release evidence asset does not match local bytes: ${remote?.name ?? 'unknown'}`);
    }
    expectedByName.delete(remote.name);
  }
  if (expectedByName.size > 0) fail('Immutable release evidence is missing required local assets.');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) fail(`Invalid release evidence argument: ${name ?? '(missing)'}`);
    options[name.slice(2)] = value;
  }
  for (const name of ['repository', 'source-sha', 'manifest', 'sbom-dir', 'trivy-dir', 'dast-dir', 'load-dir', 'zap-image', 'artillery-image']) {
    if (!options[name]) fail(`--${name} is required.`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) fail('--repository must be owner/name.');
  return options;
}

function githubClient(repository, token) {
  if (!token || /[\r\n]/.test(token)) fail('GITHUB_TOKEN is required for immutable release evidence publication.');
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'LunchLineup-release-evidence',
    'X-GitHub-Api-Version': apiVersion,
  };

  async function request(url, { method = 'GET', body, contentType } = {}) {
    const response = await fetch(url.startsWith('https://') ? url : `${apiRoot}${url}`, {
      method,
      headers: {
        ...headers,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    const text = await response.text();
    let value = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        fail(`GitHub returned non-JSON for ${method} ${url}.`);
      }
    }
    if (!response.ok) {
      fail(`GitHub ${method} ${url} failed with ${response.status}: ${value?.message ?? 'request failed'}`);
    }
    return value;
  }

  return { request };
}

async function publish(options) {
  const sourceSha = options['source-sha'];
  const assets = collectReleaseEvidence({
    manifestPath: options.manifest,
    sbomDir: options['sbom-dir'],
    trivyDir: options['trivy-dir'],
    dastDir: options['dast-dir'],
    loadDir: options['load-dir'],
    sourceSha,
    zapImage: options['zap-image'],
    artilleryImage: options['artillery-image'],
  });
  const client = githubClient(options.repository, process.env.GITHUB_TOKEN);
  const immutable = await client.request('/immutable-releases');
  if (immutable?.enabled !== true) fail('Repository immutable releases must be enabled before release evidence publication.');

  const tag = `release-evidence-${sourceSha}`;
  const releases = await client.request('/releases?per_page=100');
  let release = releases.find((entry) => entry?.tag_name === tag) ?? null;
  if (release && !release.draft) {
    const remoteAssets = await client.request(`/releases/${release.id}/assets?per_page=100`);
    validateImmutableRelease(release, remoteAssets, assets, sourceSha);
    console.log(`release_evidence_ok tag=${tag} assets=${assets.length} existing=true`);
    return;
  }
  if (release?.draft) {
    await client.request(`/releases/${release.id}`, { method: 'DELETE' });
    release = null;
  }

  let draft = null;
  try {
    draft = await client.request('/releases', {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: sourceSha,
        name: `Release evidence ${sourceSha}`,
        body: 'Signed SBOM, vulnerability, DAST, and load evidence for the exact digest-pinned LunchLineup release candidate.',
        draft: true,
        prerelease: true,
        generate_release_notes: false,
      }),
    });
    const uploadRoot = String(draft.upload_url ?? '').replace(/\{.*$/, '');
    if (!uploadRoot.startsWith('https://uploads.github.com/')) fail('GitHub release upload URL is not trusted.');
    for (const asset of assets) {
      await client.request(`${uploadRoot}?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST',
        contentType: asset.name.endsWith('.html') ? 'text/html' : 'application/json',
        body: asset.bytes,
      });
    }
    release = await client.request(`/releases/${draft.id}`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: JSON.stringify({ draft: false, prerelease: true }),
    });
  } catch (error) {
    if (draft?.id) {
      try {
        await client.request(`/releases/${draft.id}`, { method: 'DELETE' });
      } catch {
        // Preserve the original publication error; a stale draft is safe and repairable.
      }
    }
    throw error;
  }

  const remoteAssets = await client.request(`/releases/${release.id}/assets?per_page=100`);
  validateImmutableRelease(release, remoteAssets, assets, sourceSha);
  console.log(`release_evidence_ok tag=${tag} assets=${assets.length} existing=false`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publish(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`Immutable release evidence publication failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
