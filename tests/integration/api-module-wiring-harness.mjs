import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');

const require = createRequire(import.meta.url);
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
require('reflect-metadata');

const { Test } = requireApi('@nestjs/testing');
const { AppModule } = require('../../apps/api/src/app.module.ts');
const { RbacService } = require('../../apps/api/src/auth/rbac.service.ts');

function safeFailureLabel(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/JWT_REFRESH_SECRET/.test(message)) return 'JWT_REFRESH_SECRET';
  if (/JWT_SECRET/.test(message)) return 'JWT_SECRET';
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : 'UnknownError';
}

try {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  try {
    if (!moduleRef.get(RbacService)) throw new Error('RbacServiceUnavailable');
  } finally {
    await moduleRef.close();
  }
  process.stdout.write('app-module-compile-close:ok\n');
} catch (error) {
  process.stderr.write(`app-module-compile-failed:${safeFailureLabel(error)}\n`);
  process.exitCode = 1;
}
