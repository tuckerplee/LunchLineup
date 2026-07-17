import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { probeExternalHealthRelease } from '../../scripts/verify-external-health-release.mjs';

const sourceSha = 'a'.repeat(40);
const healthUrl = 'https://lunchlineup.example/health';
const checkedAt = '2026-07-13T12:00:00.000Z';

function successfulFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    const body = Buffer.from('{"status":"ok"}');
    return {
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'x-lunchlineup-release' ? sourceSha : null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function runProbe(environment, calls = []) {
  const proof = await probeExternalHealthRelease({
    healthUrl,
    expectedReleaseSha: sourceSha,
    environment,
    fetchImpl: successfulFetch(calls),
    checkedAt,
  });
  return { calls, proof };
}

test('external health probe remains public when Cloudflare Access credentials are absent', async () => {
  const { calls } = await runProbe({});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.protocol, 'https:');
  assert.equal(calls[0].url.searchParams.get('lunchlineup_release_probe'), sourceSha);
  const { signal, ...options } = calls[0].options;
  assert.equal(signal.aborted, false);
  assert.deepEqual(options, {
    cache: 'no-store',
    redirect: 'error',
    headers: { 'cache-control': 'no-cache' },
  });
});

test('external health probe sends a complete Cloudflare Access service-token pair', async () => {
  const clientId = 'test-client-id';
  const clientSecret = 'test-client-secret';
  const { calls, proof } = await runProbe({
    CF_ACCESS_CLIENT_ID: clientId,
    CF_ACCESS_CLIENT_SECRET: clientSecret,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.headers, {
    'cache-control': 'no-cache',
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  });

  const stdout = `${JSON.stringify(proof, null, 2)}\n`;
  for (const credential of [clientId, clientSecret]) {
    assert.equal(stdout.includes(credential), false);
    assert.equal(proof.command.includes(credential), false);
  }
});

function publicHtmlResponse({ status = 200, releaseSha = sourceSha } = {}) {
  const body = Buffer.from(`<html><body><h1>LunchLineup</h1><script src="/_next/static/app.js"></script>${'x'.repeat(1100)}</body></html>`);
  return {
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'x-lunchlineup-release') return releaseSha;
        if (name.toLowerCase() === 'content-type') return 'text/html; charset=utf-8';
        return null;
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

test('canonical public HTML probe uses the exact root URL and requires HTML plus release identity', async () => {
  const calls = [];
  const proof = await probeExternalHealthRelease({
    healthUrl: 'https://lunchlineup.example/',
    expectedReleaseSha: sourceSha,
    expectPublicHtml: true,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return publicHtmlResponse();
    },
    checkedAt,
  });

  assert.equal(calls[0].url.href, 'https://lunchlineup.example/');
  assert.equal(proof.surface, 'public-html');
  assert.match(proof.command, /--expect-public-html/);
});

test('green API health cannot hide public web 503 or wrong release SHA', async () => {
  await runProbe({});

  for (const response of [
    publicHtmlResponse({ status: 503 }),
    publicHtmlResponse({ releaseSha: 'b'.repeat(40) }),
  ]) {
    await assert.rejects(
      probeExternalHealthRelease({
        healthUrl: 'https://lunchlineup.example/',
        expectedReleaseSha: sourceSha,
        expectPublicHtml: true,
        fetchImpl: async () => response,
      }),
      /HTTP 503|served release b{40}/,
    );
  }
});

test('external probe aborts a TLS peer that accepts but never responds', async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await assert.rejects(
      probeExternalHealthRelease({
        healthUrl: `https://127.0.0.1:${port}/health`,
        expectedReleaseSha: sourceSha,
        requestTimeoutMs: 100,
      }),
      /timed out after 100ms/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  }
});

test('external health probe rejects either partial credential pair before fetch without leaking it', async () => {
  const partialEnvironments = [
    { CF_ACCESS_CLIENT_ID: 'partial-client-id' },
    { CF_ACCESS_CLIENT_SECRET: 'partial-client-secret' },
  ];

  for (const environment of partialEnvironments) {
    let fetchCalls = 0;
    let caught;
    try {
      await probeExternalHealthRelease({
        healthUrl,
        expectedReleaseSha: sourceSha,
        environment,
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error('fetch must not run');
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(fetchCalls, 0);
    assert.match(caught?.message ?? '', /must be set together/);
    for (const credential of Object.values(environment)) {
      assert.equal((caught?.message ?? '').includes(credential), false);
    }
  }
});
