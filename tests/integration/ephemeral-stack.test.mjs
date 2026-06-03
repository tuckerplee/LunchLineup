import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function requireServiceUrl(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for integration tests`);
  return new URL(value);
}

function connect(url, defaultPort) {
  const port = Number(url.port || defaultPort);

  return new Promise((resolveConnect, reject) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${url.hostname}:${port}`));
    }, 5000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolveConnect();
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('ephemeral postgres and redis services accept TCP connections', async () => {
  await connect(requireServiceUrl('DATABASE_URL'), 5432);
  await connect(requireServiceUrl('REDIS_URL'), 6379);
});

test('prisma migrations are current against ephemeral postgres', () => {
  const databaseUrl = requireServiceUrl('DATABASE_URL').toString();
  const output = execFileSync(
    npx,
    ['prisma', 'migrate', 'status', '--schema', 'packages/db/prisma/schema.prisma'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    }
  );

  assert.match(output, /Database schema is up to date|No pending migrations/i);
});
