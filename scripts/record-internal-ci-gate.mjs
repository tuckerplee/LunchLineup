import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [name, output] = process.argv.slice(2);
const sourceSha = process.env.CI_COMMIT_SHA ?? '';
if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-z][a-z0-9-]+$/.test(name ?? '') || !output) {
  throw new Error('Usage: node scripts/record-internal-ci-gate.mjs <gate-name> <output>');
}
const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({
  name,
  status: 'passed',
  sourceSha,
  attempts: 1,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
