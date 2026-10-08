/** VM218 admission wrapper for the shared native session-security scenario. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertE2ESeedTarget } from '../../scripts/data-target-guard.mjs';
import { runNativeSessionSecurity, validateNativeSessionSecurityTarget } from './native-session-security-case.mjs';

const root=resolve(import.meta.dirname,'../..'), cap=64*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function admittedContext(){
  // Canonical target checks precede loading Prisma/TS/native application code.
  assert.equal(process.env.DATA_TARGET_ENV,'disposable');assertE2ESeedTarget(process.env);
  assert.equal(process.env.CI_REPOSITORY,'lunchlineup');
  const runId=process.env.CI_RUN_ID,sourceSha=process.env.CI_COMMIT_SHA;
  assert.match(runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);assert.match(sourceSha??'',/^[a-f0-9]{40}$/);
  const workspace=`/var/lib/custom-ci/workspaces/${runId}`,temporary=`/var/lib/custom-ci/runs/${runId}/tmp/job-tmp`;
  assert.equal(process.env.CI_WORKSPACE,workspace);assert.equal(process.env.RUNNER_TEMP,temporary);
  assert.equal(root,`${temporary}/lunchlineup-source-${runId}/build`);assert.equal(await realpath(root),root);
  const path=`${workspace}/.release/internal-ci/${sourceSha}/integration-target.json`;
  assert.equal(await realpath(path),path);const meta=await stat(path);assert.equal(meta.isFile(),true);assert.equal(meta.mode&0o077,0);
  const bytes=await readFile(path);assert.ok(bytes.length<=cap);const target=JSON.parse(bytes.toString('utf8'));
  const prefix=`lunchlineup-integration-${runId.replace(/[^a-zA-Z0-9]/g,'')}`;
  assert.deepEqual(target,{runId,sourceSha,workspace,temporaryRoot:temporary,mutationRole:'lunchlineup_ci_app',
    dataTargetEnvironment:'disposable',database:'lunchlineup_test',store:`${temporary}/lunchlineup-integration-containers-${runId}`,
    containers:['postgres','redis','rabbitmq'].map(name=>`${prefix}-${name}`)});
  assert.equal(await realpath(target.store),target.store);
  // Receipt is correlation, NOT independent controller authority. Only the
  // existing root-owned wrapper can admit the actual fresh store/containers.
  const {redisUrl}=validateNativeSessionSecurityTarget();
  return {runId,sourceSha,workspace,redisUrl,targetReceiptSha256:sha(bytes),executionTarget:'vm218'};
}

test('native session security binds signed JWTs to live restricted PostgreSQL and real Redis MFA over owned loopback HTTP',{timeout:180000},async()=>{
  const context=await admittedContext();
  await runNativeSessionSecurity(context);
});
