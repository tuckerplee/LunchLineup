import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function windowsMsysProcessGroup(bash, windowsPid) {
  if (!bash || !existsSync(bash)) return undefined;
  const ps = [
    join(dirname(bash), 'ps.exe'),
    join(dirname(dirname(bash)), 'usr', 'bin', 'ps.exe'),
  ].find((candidate) => existsSync(candidate));
  if (!ps) return undefined;

  const result = spawnSync(ps, ['-l', '-W'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/, 8);
    const [msysPidText, , processGroupText, winPidText] = columns;
    const msysPid = Number(msysPidText);
    const processGroup = Number(processGroupText);
    const winPid = Number(winPidText);
    if (
      Number.isSafeInteger(msysPid)
      && Number.isSafeInteger(processGroup)
      && winPid === windowsPid
      // The detached command owner must lead its own MSYS process group. This
      // prevents a timeout cleanup from ever signalling an unrelated shell.
      && msysPid === processGroup
    ) {
      return { bash, processGroup };
    }
  }
  return undefined;
}

function terminateProcessTree(pid, force, msysGroup) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    if (msysGroup) {
      spawnSync(msysGroup.bash, [
        '-c',
        `kill -${force ? 'KILL' : 'TERM'} -- "-$1"`,
        'bounded-child-process',
        String(msysGroup.processGroup),
      ], {
        stdio: 'ignore',
        timeout: 2_000,
        windowsHide: true,
      });
    }
    spawnSync('taskkill.exe', [
      '/PID',
      String(pid),
      '/T',
      // Windows has no reliable TERM equivalent for an arbitrary detached
      // POSIX-emulated process tree. Force the complete owned tree on the
      // first timeout signal so a surviving grandchild cannot keep pipes or
      // destructive work alive after the owner returns.
      '/F',
    ], {
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process group may already have exited.
  }
}

export function runBoundedProcessResult(command, args, options) {
  const {
    cwd,
    env,
    input,
    label = command,
    stdio = input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    timeoutMs,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    windowsMsysBash,
    detached = true,
  } = options;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('runBoundedProcess requires a positive integer timeoutMs');
  }
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new Error('runBoundedProcess requires a positive integer terminationGraceMs');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached,
      env,
      stdio,
      windowsHide: true,
    });
    let completed = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      const msysGroup = process.platform === 'win32'
        ? windowsMsysProcessGroup(windowsMsysBash, child.pid)
        : undefined;
      terminateProcessTree(child.pid, false, msysGroup);
      setTimeout(() => {
        terminateProcessTree(child.pid, true, msysGroup);
        if (!completed) {
          completed = true;
          resolve({ code: 124, signal: null, timedOut: true });
        }
      }, terminationGraceMs);
    }, timeoutMs);

    child.once('error', (error) => {
      if (completed || timedOut) return;
      completed = true;
      clearTimeout(timeout);
      reject(new Error(`${label} could not start: ${error.code ?? error.name}`));
    });

    child.once('close', (code, signal) => {
      // A parent can exit after TERM while one of its descendants survives.
      // Keep the timeout owner alive through the forced tree cleanup below.
      if (completed || timedOut) return;
      completed = true;
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });

    if (input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
  });
}

export async function runBoundedProcess(command, args, options) {
  const result = await runBoundedProcessResult(command, args, options);
  const { label = command, timeoutMs } = options;
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  if (result.code === 0) return result;
  throw new Error(`${label} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}`);
}
