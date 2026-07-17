#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyExternalHealthResponse({
  status,
  servedReleaseSha,
  expectedReleaseSha,
  bodyBytes,
  contentType = '',
  expectPublicHtml = false,
}) {
  if (status !== 200) throw new Error(`external health returned HTTP ${status}.`);
  if (servedReleaseSha !== expectedReleaseSha) {
    throw new Error(`external health served release ${servedReleaseSha || 'missing'}, expected ${expectedReleaseSha}.`);
  }
  if (!Buffer.isBuffer(bodyBytes) || bodyBytes.length === 0) throw new Error('external health response body is empty.');
  if (!expectPublicHtml) return;
  if (!/^text\/html(?:;|$)/i.test(contentType.trim())) {
    throw new Error(`public web response Content-Type is ${contentType || 'missing'}, expected text/html.`);
  }
  if (bodyBytes.length < 1024) throw new Error(`public web response is too small (${bodyBytes.length} bytes).`);
  const html = bodyBytes.toString('utf8');
  if (!html.includes('<h1>LunchLineup</h1>')) throw new Error('public web response is missing the LunchLineup application heading.');
  if (!html.includes('/_next/static/')) throw new Error('public web response is missing a Next.js static asset reference.');
}

export function externalHealthRequestOptions(environment = process.env, signal) {
  const clientId = environment.CF_ACCESS_CLIENT_ID;
  const clientSecret = environment.CF_ACCESS_CLIENT_SECRET;
  const hasClientId = clientId !== undefined;
  const hasClientSecret = clientSecret !== undefined;

  if (hasClientId !== hasClientSecret) {
    throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together.');
  }
  if (hasClientId && (!clientId || !clientSecret)) {
    throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must both be non-empty.');
  }

  const headers = { 'cache-control': 'no-cache' };
  if (hasClientId) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }
  return { cache: 'no-store', redirect: 'error', headers, ...(signal ? { signal } : {}) };
}

function requestTimeoutMs(value) {
  const parsed = Number(value ?? 10_000);
  if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 60_000) {
    throw new Error('EXTERNAL_HEALTH_REQUEST_TIMEOUT_MS must be an integer from 50 through 60000.');
  }
  return parsed;
}

function validatePublicHtmlUrl(url) {
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('Public web release proof requires an HTTPS URL.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Public web release proof requires the canonical HTTPS root URL without credentials, query, or fragment.');
  }
}

export async function probeExternalHealthRelease({
  healthUrl,
  expectedReleaseSha,
  environment = process.env,
  fetchImpl = fetch,
  checkedAt = new Date().toISOString(),
  expectPublicHtml = false,
  requestTimeoutMs: timeoutOverride,
}) {
  const url = new URL(healthUrl);
  if (url.protocol !== 'https:') throw new Error('External health release proof requires HTTPS.');
  if (expectPublicHtml) validatePublicHtmlUrl(url);
  else url.searchParams.set('lunchlineup_release_probe', expectedReleaseSha);

  const timeoutMs = requestTimeoutMs(timeoutOverride ?? environment.EXTERNAL_HEALTH_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  let bodyBytes;
  try {
    response = await fetchImpl(url, externalHealthRequestOptions(environment, controller.signal));
    bodyBytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`external health request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const servedReleaseSha = response.headers.get('x-lunchlineup-release')?.trim() ?? '';
  const contentType = response.headers.get('content-type')?.trim() ?? '';
  verifyExternalHealthResponse({
    status: response.status,
    servedReleaseSha,
    expectedReleaseSha,
    bodyBytes,
    contentType,
    expectPublicHtml,
  });
  return {
    status: 'passed',
    sourceSha: expectedReleaseSha,
    checkedAt,
    command: `node scripts/verify-external-health-release.mjs ${healthUrl} ${expectedReleaseSha}${expectPublicHtml ? ' --expect-public-html' : ''}`,
    exitCode: 0,
    healthUrl,
    httpStatus: response.status,
    releaseIdentityHeader: 'X-LunchLineup-Release',
    servedReleaseSha,
    responseSha256: createHash('sha256').update(bodyBytes).digest('hex'),
    responseBytes: bodyBytes.length,
    surface: expectPublicHtml ? 'public-html' : 'health',
    requestTimeoutMs: timeoutMs,
  };
}

async function main() {
  const [healthUrl, expectedReleaseSha, ...args] = process.argv.slice(2);
  let outputPath;
  let expectPublicHtml = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--expect-public-html') {
      expectPublicHtml = true;
      continue;
    }
    if (args[index] === '--output' && args[index + 1]) {
      outputPath = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete external health option: ${args[index] ?? '(missing)'}`);
  }
  if (!healthUrl || !/^[a-f0-9]{40}$/i.test(expectedReleaseSha ?? '')) {
    throw new Error('Usage: verify-external-health-release.mjs HTTPS_URL RELEASE_SHA [--expect-public-html] [--output PATH]');
  }
  const proof = await probeExternalHealthRelease({ healthUrl, expectedReleaseSha, expectPublicHtml });
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
