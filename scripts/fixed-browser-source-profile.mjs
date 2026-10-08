// Fixed owner metadata is the only disposable CLI selector. Generic callers
// retain the version-1 default; neither argv nor an env-selected JSON path can
// authorize a profile. The controller creates this record after authentication.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';

export function readFixedBrowserSourceProfile(options, env = process.env) {
  const run = env.CI_RUN_ID;
  if (run === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(run)) throw new Error('Invalid fixed browser run.');
  const path = `/var/lib/custom-ci/runs/${run}/browser-source-profile.json`;
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || realpathSync(parent) !== parent) throw new Error('Unprotected fixed browser profile parent.');
    if (parent === '/') break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let record;
  try {
    const first = fstatSync(fd);
    if (!first.isFile() || first.uid !== 0 || first.nlink !== 1 || (first.mode & 0o7777) !== 0o444 || first.size < 1 || first.size > 8192) throw new Error('Unprotected fixed browser profile.');
    const buffer = Buffer.alloc(8193); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const last = fstatSync(fd), named = lstatSync(path);
    const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
    if (length !== first.size || named.isSymbolicLink() || fields.some(key => first[key] !== last[key] || first[key] !== named[key])) throw new Error('Fixed browser profile changed during read.');
    record = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
  if (!record || Object.keys(record).sort().join(',') !== 'materializerSha256,runId,sourceProfile' || record.runId !== run || !/^[a-f0-9]{64}$/.test(record.materializerSha256)) throw new Error('Invalid fixed browser profile record.');
  const profile = selectInternalCiSourceProfile(record.sourceProfile);
  const workspace = `/var/lib/custom-ci/workspaces/${run}`;
  const temporary = `/var/lib/custom-ci/runs/${run}/tmp/job-tmp`;
  if (!/^[0-9]{8}T[0-9]{6}Z-lunchlineup-[a-f0-9]{8}-[a-f0-9]{6}$/.test(run) || profile.version !== 2 || profile.pipelinePath !== '.ci/development-browser.pipeline.json' || env.CI_COMMIT_SHA !== profile.sourceSha || env.CI_REF !== profile.sourceRef || env.CI_RUN_ATTEMPT !== '1' || env.CI_REPOSITORY !== 'lunchlineup' || env.LUNCHLINEUP_DEVELOPMENT_QA !== '1' || env.CI_WORKSPACE !== workspace || env.RUNNER_TEMP !== temporary) throw new Error('Fixed browser source invocation mismatch.');
  const contextInvocation = Object.keys(options).join(',') === 'contextPath' &&
    resolve(options.contextPath) === `${temporary}/lunchlineup-source-${run}/source-context.json`;
  const cloneInvocation = Object.keys(options).sort().join(',') === 'clone,proofPath,purpose,requireClean' &&
    options.purpose === 'build' && options.requireClean === true &&
    resolve(options.clone) === `${temporary}/lunchlineup-source-${run}/build` &&
    resolve(options.proofPath) === `${workspace}/.release/internal-ci/${profile.sourceSha}/source/source-proof.json`;
  if (!contextInvocation && !cloneInvocation) throw new Error('Fixed browser source invocation mismatch.');
  return profile;
}
