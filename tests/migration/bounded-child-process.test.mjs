import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBoundedProcess } from '../../scripts/bounded-child-process.mjs';

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceCleanup(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The test process group already exited.
  }
}

test('bounded child owner terminates a TERM-ignoring descendant before delayed output', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lunchlineup-bounded-child-'));
  const childPath = join(directory, 'child.cjs');
  const parentPath = join(directory, 'parent.cjs');
  const pidPath = join(directory, 'pids.txt');
  const outputPath = join(directory, 'late-output.txt');
  let parentPid;

  await writeFile(childPath, `
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
setTimeout(() => writeFileSync(${JSON.stringify(outputPath)}, 'late write'), 1500);
setInterval(() => {}, 1000);
`);
  await writeFile(parentPath, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n' + child.pid + '\\n');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);

  try {
    await assert.rejects(
      runBoundedProcess(process.execPath, [parentPath], {
        stdio: 'ignore',
        timeoutMs: 300,
        terminationGraceMs: 300,
        label: 'TERM-ignoring fixture',
      }),
      /timed out after 300ms/,
    );
    const pids = (await readFile(pidPath, 'utf8')).trim().split(/\s+/).map(Number);
    [parentPid] = pids;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(processExists(pids[0]), false, 'parent survived timeout cleanup');
    assert.equal(processExists(pids[1]), false, 'descendant survived timeout cleanup');
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    forceCleanup(parentPid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded child owner terminates descendants when the parent accepts TERM', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lunchlineup-bounded-parent-exit-'));
  const childPath = join(directory, 'child.cjs');
  const parentPath = join(directory, 'parent.cjs');
  const pidPath = join(directory, 'pids.txt');
  const outputPath = join(directory, 'orphan-output.txt');
  let parentPid;

  await writeFile(childPath, `
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
setTimeout(() => writeFileSync(${JSON.stringify(outputPath)}, 'orphan write'), 1500);
setInterval(() => {}, 1000);
`);
  await writeFile(parentPath, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n' + child.pid + '\\n');
setInterval(() => {}, 1000);
`);

  try {
    await assert.rejects(
      runBoundedProcess(process.execPath, [parentPath], {
        stdio: 'ignore',
        timeoutMs: 300,
        terminationGraceMs: 300,
        label: 'parent-exit fixture',
      }),
      /timed out after 300ms/,
    );
    const pids = (await readFile(pidPath, 'utf8')).trim().split(/\s+/).map(Number);
    [parentPid] = pids;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(processExists(pids[0]), false, 'parent survived timeout cleanup');
    assert.equal(processExists(pids[1]), false, 'orphan descendant survived timeout cleanup');
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    forceCleanup(parentPid);
    await rm(directory, { recursive: true, force: true });
  }
});
