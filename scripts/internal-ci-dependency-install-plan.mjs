import { resolve } from 'node:path';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { verifyInternalCiSourceClone } from './verify-internal-ci-source-clone.mjs';

// Definition-only handoff for an independently authenticated controller adapter.
// The caller retains custody/quota/child ownership and must execute immediately
// under that custody. A plan is neither installation evidence nor native admission.
export function prepareInternalCiDependencyInstall(contextPath, { expectedSource, env = process.env } = {}) {
  const context = readInternalCiSourceContext(contextPath, { expectedSource, env, verifyClones: true });
  if (resolve(contextPath) !== resolve(context.runRoot, 'source-context.json')) throw new Error('Dependency context path mismatch.');
  verifyInternalCiSourceClone({ proofPath: context.sourceProofPath, clone: context.buildSourcePath, purpose: 'build', requireClean: true, expectedSource });
  return Object.freeze({ cwd: context.buildSourcePath, executable: 'npm', args: Object.freeze(['ci']), logPath: resolve(context.artifactRoot, 'source/npm-ci.log'), sourceSha: context.sourceSha, installProved: false, nativeQualified: false, releaseQualified: false });
}
