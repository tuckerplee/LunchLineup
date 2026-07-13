#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyExternalHealthResponse({ status, servedReleaseSha, expectedReleaseSha, bodyBytes }) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`external health returned HTTP ${status}.`);
  if (servedReleaseSha !== expectedReleaseSha) {
    throw new Error(`external health served release ${servedReleaseSha || 'missing'}, expected ${expectedReleaseSha}.`);
  }
  if (!Buffer.isBuffer(bodyBytes) || bodyBytes.length === 0) throw new Error('external health response body is empty.');
}

async function main() {
  const [healthUrl, expectedReleaseSha, outputFlag, outputPath] = process.argv.slice(2);
  if (!healthUrl || !/^[a-f0-9]{40}$/i.test(expectedReleaseSha ?? '') || (outputFlag && outputFlag !== '--output') || (outputFlag && !outputPath)) {
    throw new Error('Usage: verify-external-health-release.mjs HTTPS_URL RELEASE_SHA [--output PATH]');
  }
  const url = new URL(healthUrl);
  if (url.protocol !== 'https:') throw new Error('External health release proof requires HTTPS.');
  url.searchParams.set('lunchlineup_release_probe', expectedReleaseSha);
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', headers: { 'cache-control': 'no-cache' } });
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  const servedReleaseSha = response.headers.get('x-lunchlineup-release')?.trim() ?? '';
  verifyExternalHealthResponse({ status: response.status, servedReleaseSha, expectedReleaseSha, bodyBytes });
  const proof = {
    status: 'passed',
    sourceSha: expectedReleaseSha,
    checkedAt: new Date().toISOString(),
    command: `node scripts/verify-external-health-release.mjs ${healthUrl} ${expectedReleaseSha}`,
    exitCode: 0,
    healthUrl,
    httpStatus: response.status,
    releaseIdentityHeader: 'X-LunchLineup-Release',
    servedReleaseSha,
    responseSha256: createHash('sha256').update(bodyBytes).digest('hex'),
    responseBytes: bodyBytes.length,
  };
  const bytes = `${JSON.stringify(proof, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, bytes, { mode: 0o600 });
  process.stdout.write(bytes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
