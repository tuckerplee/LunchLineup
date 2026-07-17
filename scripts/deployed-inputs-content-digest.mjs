#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function computeDeployedInputsContentDigest(rootPath) {
  const root = resolve(rootPath);
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`Deployed-input path is not a directory: ${root}`);
  }

  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).split(sep).join('/'));
      } else {
        throw new Error(`Unsupported deployed-input entry: ${absolute}`);
      }
    }
  }

  visit(root);
  files.sort(compareUtf8Paths);
  if (files.length === 0) {
    throw new Error('Deployed-input directory is empty.');
  }

  const digest = createHash('sha256');
  for (const relativePath of files) {
    const content = readFileSync(join(root, ...relativePath.split('/')));
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const header = Buffer.alloc(16);
    header.writeBigUInt64BE(BigInt(pathBytes.length), 0);
    header.writeBigUInt64BE(BigInt(content.length), 8);
    digest.update(header);
    digest.update(pathBytes);
    digest.update(content);
  }

  return digest.digest('hex');
}

function main() {
  const [rootPath, ...extraArguments] = process.argv.slice(2);
  if (!rootPath || extraArguments.length > 0) {
    throw new Error('Usage: node scripts/deployed-inputs-content-digest.mjs <directory>');
  }
  process.stdout.write(`${computeDeployedInputsContentDigest(rootPath)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
