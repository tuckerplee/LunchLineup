import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function terminateProcessTree(pid, force) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', [
      '/PID',
      String(pid),
      '/T',
      ...(force ? ['/F'] : []),
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

export function runBoundedProcess(command, args, options) {
  const {
    cwd,
    env,
    input,
    label = command,
    stdio = input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    timeoutMs,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
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
      detached: true,
      env,
      stdio,
      windowsHide: true,
    });
    let completed = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, false);
      setTimeout(() => {
        terminateProcessTree(child.pid, true);
        if (!completed) {
          completed = true;
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
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
      if (completed || timedOut) return;
      completed = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ code, signal });
        return;
      }
      reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });

    if (input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
  });
}
