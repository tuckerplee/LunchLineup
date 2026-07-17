import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const host = process.env.PITR_WAL_PROVIDER_HOST ?? '0.0.0.0';
const port = boundedInteger('PITR_WAL_PROVIDER_PORT', 8080, 1, 65535);
const maxBytes = boundedInteger('PITR_WAL_PROVIDER_MAX_BYTES', 33_554_432, 1_048_576, 67_108_864);
const requestTimeoutMs = boundedInteger(
  'PITR_WAL_PROVIDER_REQUEST_TIMEOUT_MS',
  900_000,
  1_000,
  1_200_000,
);
const uploadScript = process.env.PITR_WAL_PROVIDER_UPLOAD_SCRIPT
  ?? '/opt/lunchlineup/infrastructure/postgres/pitr-wal-provider-upload.sh';
const archiveNamePattern = /^(?:[0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$/;
let busy = false;
let activeChild = null;

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function exitAfterResponse(response, exitCode) {
  server.close();
  const fallback = setTimeout(() => process.exit(exitCode), 1_000);
  response.once('finish', () => {
    clearTimeout(fallback);
    setTimeout(() => process.exit(exitCode), 25);
  });
}

async function receiveBody(request, outputPath, expectedBytes) {
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  let receivedBytes = 0;
  try {
    for await (const chunk of request) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes || receivedBytes > expectedBytes) {
        throw new Error('request body exceeds its declared bound');
      }
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (receivedBytes !== expectedBytes) throw new Error('request body length does not match Content-Length');
}

function boundedFile(path, maximum) {
  const size = statSync(path).size;
  if (size > maximum) throw new Error('provider output exceeded its bound');
  return readFileSync(path, 'utf8');
}

async function processArchive(request, response, archiveName) {
  const rawLength = request.headers['content-length'];
  if (
    typeof rawLength !== 'string'
    || !/^[1-9][0-9]*$/.test(rawLength)
    || Number(rawLength) > maxBytes
  ) {
    send(response, 411, 'pitr_wal_provider_length_required\n');
    return;
  }

  busy = true;
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-wal-provider-'));
  const sourcePath = join(scratch, 'archive');
  const stdoutPath = join(scratch, 'stdout');
  const stderrPath = join(scratch, 'stderr');
  let ownershipUnknown = false;
  try {
    await receiveBody(request, sourcePath, Number(rawLength));
    const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
    const stderrFd = openSync(stderrPath, 'wx', 0o600);
    let child;
    try {
      child = spawn('/bin/sh', [uploadScript, sourcePath, archiveName], {
        env: {
          ...process.env,
          PITR_PROVIDER_OWNERSHIP_MODE: 'container-job',
        },
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    activeChild = child;

    const deadline = setTimeout(() => {
      ownershipUnknown = true;
      child.kill('SIGTERM');
      send(response, 503, 'pitr_wal_provider_unavailable\n');
      exitAfterResponse(response, 70);
    }, requestTimeoutMs);

    const outcome = await new Promise((resolve) => {
      child.once('error', () => resolve({ exitCode: null, signal: 'spawn-error' }));
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const { exitCode, signal } = outcome;
    clearTimeout(deadline);
    activeChild = null;
    if (response.writableEnded) return;

    const stdout = boundedFile(stdoutPath, 16_384);
    const stderrBytes = statSync(stderrPath).size;
    const expectedProof = new RegExp(
      `^pitr_wal_provider_uploaded name=${archiveName} version_id=[A-Za-z0-9._+=:/-]+ conditional_create=true\\n$`,
    );
    if (exitCode !== 0 || signal !== null || !expectedProof.test(stdout)) {
      ownershipUnknown = exitCode === 70;
      console.error(
        `pitr_wal_provider_failed name=${archiveName} exit_code=${exitCode ?? 'signal'} stderr_bytes=${stderrBytes}`,
      );
      send(response, 503, 'pitr_wal_provider_unavailable\n');
      exitAfterResponse(response, ownershipUnknown ? 70 : 1);
      return;
    }

    send(response, 200, stdout);
    exitAfterResponse(response, 0);
  } catch {
    if (!response.writableEnded) send(response, 400, 'pitr_wal_provider_invalid_request\n');
    busy = false;
  } finally {
    if (!ownershipUnknown && activeChild === null) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, busy ? 'busy\n' : 'ready\n');
    return;
  }
  const match = /^\/archive\/([^/?#]+)$/.exec(request.url ?? '');
  if (request.method !== 'POST' || !match || !archiveNamePattern.test(match[1])) {
    send(response, 404, 'not_found\n');
    return;
  }
  if (busy) {
    send(response, 503, 'pitr_wal_provider_busy\n');
    return;
  }
  void processArchive(request, response, match[1]);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    activeChild?.kill('SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

server.listen(port, host, () => {
  console.log(`pitr_wal_provider_ready host=${host} port=${port} max_bytes=${maxBytes}`);
});
