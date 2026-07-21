import { runBoundedProcessResult } from './bounded-child-process.mjs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_TIMEOUT_SECONDS = 7_200;
const DEFAULT_KILL_AFTER_SECONDS = 5;
const MAX_KILL_AFTER_SECONDS = 60;
const PRESERVED_MSYS_ARGUMENTS_MARKER = 'LUNCHLINEUP_BOUNDED_COMMAND_PRESERVE_MSYS_ARGUMENTS';

function fail(message) {
  throw new Error(message);
}

function positiveSeconds(flag, value, maximum) {
  if (!/^\d+$/.test(value ?? '')) fail(`${flag} must be a positive integer.`);
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maximum) {
    fail(`${flag} must be between 1 and ${maximum}.`);
  }
  return seconds;
}

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || argv.length <= separator + 1) {
    fail('Usage: node scripts/run-bounded-command.mjs --timeout-seconds <1-7200> [--kill-after-seconds <1-60>] -- <command> [args...]');
  }

  let parsedTimeoutSeconds;
  let parsedKillAfterSeconds;
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      fail(`Missing value for ${flag}.`);
    }
    if (flag === '--timeout-seconds' && parsedTimeoutSeconds === undefined) {
      parsedTimeoutSeconds = positiveSeconds(flag, value, MAX_TIMEOUT_SECONDS);
      continue;
    }
    if (flag === '--kill-after-seconds' && parsedKillAfterSeconds === undefined) {
      parsedKillAfterSeconds = positiveSeconds(flag, value, MAX_KILL_AFTER_SECONDS);
      continue;
    }
    fail('Usage: node scripts/run-bounded-command.mjs --timeout-seconds <1-7200> [--kill-after-seconds <1-60>] -- <command> [args...]');
  }
  if (parsedTimeoutSeconds === undefined) {
    fail('Missing required --timeout-seconds.');
  }
  return {
    timeoutSeconds: parsedTimeoutSeconds,
    killAfterSeconds: parsedKillAfterSeconds ?? DEFAULT_KILL_AFTER_SECONDS,
    command: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

function launchCommand(command, args) {
  if (process.platform !== 'win32') return { command, args };

  const bash = process.env.LUNCHLINEUP_BOUNDED_COMMAND_BASH
    ?? 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (!existsSync(bash)) {
    fail('A Git Bash executable is required to run POSIX commands on Windows.');
  }
  const directMsysBash = join(dirname(dirname(bash)), 'usr', 'bin', 'bash.exe');
  const processOwnerShell = existsSync(directMsysBash) ? directMsysBash : bash;
  if (command === 'bash' || command === bash || command === processOwnerShell) {
    // Callers that already supply `bash -c` launch directly so its process
    // group is the exact group the timeout owns.
    return { command: processOwnerShell, args, windowsMsysBash: processOwnerShell };
  }
  return {
    command: processOwnerShell,
    // Keep this shell as the stable Windows tree root. The status assignment
    // after `"$@"` prevents Git Bash from exec-replacing the group leader with
    // a POSIX child that could otherwise escape taskkill's owned tree.
    args: ['-c', '"$@"; command_status=$?; exit "$command_status"', 'run-bounded-command', command, ...args],
    windowsMsysBash: processOwnerShell,
  };
}

function childEnvironment() {
  const env = { ...process.env };
  if (env[PRESERVED_MSYS_ARGUMENTS_MARKER] === '1') {
    // The POSIX shell caller disabled MSYS argument conversion only while
    // invoking this Windows-hosted Node owner. Restore ordinary conversion
    // before the nested shell executes the intended command.
    delete env.MSYS2_ARG_CONV_EXCL;
    delete env[PRESERVED_MSYS_ARGUMENTS_MARKER];
  }
  return env;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const launched = launchCommand(parsed.command, parsed.args);
  const result = await runBoundedProcessResult(launched.command, launched.args, {
    cwd: process.cwd(),
    env: childEnvironment(),
    stdio: 'inherit',
    timeoutMs: parsed.timeoutSeconds * 1_000,
    terminationGraceMs: parsed.killAfterSeconds * 1_000,
    windowsMsysBash: launched.windowsMsysBash,
    label: 'Bounded command',
  });
  if (result.timedOut) {
    process.exit(124);
  }
  process.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

await main().catch((error) => {
  console.error(`bounded-command error=${error instanceof Error ? error.message : 'unknown failure'}`);
  process.exitCode = 127;
});
