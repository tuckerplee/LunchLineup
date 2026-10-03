import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBoundedProcess, runBoundedProcessResult } from '../../scripts/bounded-child-process.mjs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

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
    if (!parentPid) {
      const ownedPids = await readFile(pidPath, 'utf8').catch(() => '');
      parentPid = Number(ownedPids.trim().split(/\s+/)[0]) || undefined;
    }
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
    if (!parentPid) {
      const ownedPids = await readFile(pidPath, 'utf8').catch(() => '');
      parentPid = Number(ownedPids.trim().split(/\s+/)[0]) || undefined;
    }
    forceCleanup(parentPid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded child success reports observed direct-child closure without a group-settlement claim', async () => {
  const result = await runBoundedProcessResult(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore', timeoutMs: 5_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.childCloseObserved, true);
  assert.equal(result.processGroupSettlementVerified, false);
  assert.equal(processExists(result.directChildPid), false);
});

for (const ignoresTerm of [false, true]) {
  test(`bounded child timeout observes direct-child closure at return (ignores TERM=${ignoresTerm})`, { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lunchlineup-direct-close-'));
    const source = join(directory, 'child.cjs');
    const ready = join(directory, 'ready.txt');
    let pid;
    await writeFile(source, `
const { writeFileSync } = require('node:fs');
${ignoresTerm ? "process.on('SIGTERM', () => {});" : ''}
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    try {
      const result = await runBoundedProcessResult(process.execPath, [source], {
        stdio: 'ignore', timeoutMs: 1_000,
        terminationGraceMs: 100, terminationConfirmationMs: 1_000,
      });
      pid = Number(await readFile(ready, 'utf8'));
      assert.equal(result.directChildPid, pid);
      assert.equal(result.code, 124);
      assert.equal(result.timedOut, true);
      assert.equal(result.childCloseObserved, true);
      assert.equal(result.processGroupSettlementVerified, false);
      // No sleep after helper return: this oracle distinguishes a KILL attempt
      // from the actual close/reap event of this exact synthetic direct child.
      assert.equal(processExists(pid), false);
    } finally {
      if (!pid) pid = Number(await readFile(ready, 'utf8').catch(() => '0'));
      forceCleanup(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function mockChildSpawn(t, factory) {
  const mocked = t.mock.method(childProcess, 'spawn', factory);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

test('bounded child waits for a delayed close after the KILL phase', { timeout: 2_000 }, async (t) => {
  mockChildSpawn(t, () => {
    const child = new EventEmitter();
    // No PID: this deterministic event fixture can never signal a real group.
    child.pid = undefined;
    const close = setTimeout(() => child.emit('close', null, 'SIGKILL'), 50);
    t.after(() => clearTimeout(close));
    return child;
  });
  const result = await runBoundedProcessResult('synthetic-no-executable', [], {
    stdio: 'ignore', timeoutMs: 5,
    terminationGraceMs: 5, terminationConfirmationMs: 500,
  });
  assert.equal(result.code, 124);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.childCloseObserved, true);
  assert.equal(result.processGroupSettlementVerified, false);
});

test('bounded child reports unconfirmed closure if no close arrives and preserves it on the thrown timeout', { timeout: 2_000 }, async (t) => {
  mockChildSpawn(t, () => {
    const child = new EventEmitter();
    child.pid = undefined; // Never signal an actual process in this fault case.
    return child;
  });
  const options = {
    stdio: 'ignore', timeoutMs: 5,
    terminationGraceMs: 5, terminationConfirmationMs: 20,
    label: 'No-close synthetic fixture',
  };
  const result = await runBoundedProcessResult('synthetic-no-executable', [], options);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.childCloseObserved, false);
  assert.equal(result.processGroupSettlementVerified, false);
  await assert.rejects(runBoundedProcess('synthetic-no-executable', [], options), (error) => {
    assert.equal(error.code, 'BOUNDED_PROCESS_TIMEOUT');
    assert.equal(error.childCloseObserved, false);
    assert.equal(error.processGroupSettlementVerified, false);
    assert.match(error.message, /direct child closure unconfirmed$/);
    return true;
  });
});
