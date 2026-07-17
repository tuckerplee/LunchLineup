#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path, label) {
  const bytes = readFileSync(resolve(path));
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} must contain JSON.`);
  }
  return { bytes, value };
}

function composeImageReferences(bytes, path) {
  let compose;
  try {
    compose = parse(bytes.toString('utf8'), { merge: true, uniqueKeys: true });
  } catch (error) {
    fail(`${basename(path)} must contain valid YAML with unique mapping keys: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!compose || typeof compose !== 'object' || Array.isArray(compose)) {
    fail(`${basename(path)} must contain a Compose mapping.`);
  }
  const services = compose.services;
  if (!services || typeof services !== 'object' || Array.isArray(services) || Object.keys(services).length === 0) {
    fail(`${basename(path)} must contain a non-empty services mapping.`);
  }
  return Object.entries(services).map(([service, definition]) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      fail(`Compose service ${JSON.stringify(service)} must resolve to a service mapping.`);
    }
    if (typeof definition.image !== 'string' || definition.image.trim() === '') {
      fail(`Compose service ${JSON.stringify(service)} must resolve exactly one non-empty image.`);
    }
    return { service, value: definition.image.trim() };
  });
}

export function deriveProductionImageInventory({ manifestPath, composePath = joinRoot('docker-compose.yml') }) {
  const manifestFile = readJson(manifestPath, 'release manifest');
  const manifest = manifestFile.value;
  if (!/^[a-f0-9]{40}$/.test(String(manifest?.sourceSha ?? ''))) fail('release manifest sourceSha must be a full lowercase Git SHA.');
  if (!manifest.images || typeof manifest.images !== 'object' || Array.isArray(manifest.images)) fail('release manifest images object is required.');
  const composeAbsolute = resolve(composePath);
  const composeBytes = readFileSync(composeAbsolute);
  const inventory = [];
  const byRef = new Map();
  const names = new Map();
  const referencedManifestImages = new Set();

  for (const reference of composeImageReferences(composeBytes, composeAbsolute)) {
    let name = reference.service;
    let ref = reference.value;
    let digest;
    let source = 'compose';
    const firstParty = /^\$\{IMAGE_PREFIX(?::-[^}]*)?\}\/[a-z0-9-]+:\$\{IMAGE_TAG(?::-[^}]*)?\}$/.test(ref);
    if (firstParty) {
      const match = /\/([a-z0-9-]+):\$\{IMAGE_TAG/.exec(ref);
      name = match?.[1];
      const image = manifest.images[name];
      if (!name || !image || typeof image !== 'object') fail(`Compose service ${reference.service} has no release-manifest image.`);
      ref = String(image.ref ?? '');
      digest = String(image.digest ?? '');
      if (!digestPattern.test(digest) || !ref.endsWith(`@${digest}`)) fail(`release manifest images.${name} must be digest-pinned.`);
      source = 'release-manifest';
      referencedManifestImages.add(name);
    } else {
      const match = /^(?<image>[^\s]+)@(?<digest>sha256:[a-f0-9]{64})$/.exec(ref);
      if (!match?.groups) fail(`Compose service ${reference.service} image must be a literal digest or a release-manifest image.`);
      digest = match.groups.digest;
    }

    const existing = byRef.get(ref);
    if (existing) {
      existing.composeServices.push(reference.service);
      continue;
    }
    if (names.has(name)) fail(`Production image artifact name collision: ${name}.`);
    const image = {
      name,
      composeServices: [reference.service],
      ref,
      digest,
      source,
      registryAttestationRequired: source === 'release-manifest',
    };
    names.set(name, image);
    byRef.set(ref, image);
    inventory.push(image);
  }

  for (const name of Object.keys(manifest.images)) {
    if (!referencedManifestImages.has(name)) fail(`release manifest images.${name} is not referenced by production Compose.`);
  }
  return {
    version: 1,
    sourceSha: manifest.sourceSha,
    composeFile: 'docker-compose.yml',
    composeSha256: sha256(composeBytes),
    releaseManifestSha256: sha256(manifestFile.bytes),
    images: inventory,
  };
}

function joinRoot(path) {
  return resolve(root, path);
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function main(argv) {
  const manifestPath = option(argv, '--manifest');
  if (!manifestPath) fail('--manifest is required.');
  const inventory = deriveProductionImageInventory({
    manifestPath,
    composePath: option(argv, '--compose', joinRoot('docker-compose.yml')),
  });
  const matrixOutput = option(argv, '--github-matrix-output');
  if (matrixOutput) {
    appendFileSync(resolve(matrixOutput), `matrix=${JSON.stringify({ service: inventory.images.map(({ name }) => name) })}\n`);
    return;
  }
  const service = option(argv, '--service');
  if (service) {
    const image = inventory.images.find(({ name }) => name === service);
    if (!image) fail(`unknown production image: ${service}.`);
    const githubOutput = option(argv, '--github-output');
    if (githubOutput) {
      appendFileSync(resolve(githubOutput), [
        `ref=${image.ref}`,
        `digest=${image.digest}`,
        `image_source=${image.source}`,
        `registry_attestation_required=${image.registryAttestationRequired}`,
        `compose_services=${JSON.stringify(image.composeServices)}`,
        '',
      ].join('\n'));
      return;
    }
    process.stdout.write(`${JSON.stringify(image)}\n`);
    return;
  }
  if (argv.includes('--list')) {
    process.stdout.write(`${inventory.images.map(({ name }) => name).join('\n')}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Production image inventory failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
