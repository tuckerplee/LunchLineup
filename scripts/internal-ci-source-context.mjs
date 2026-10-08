import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');
const CANDIDATE_REF = 'refs/heads/internal-beta-candidate';
const PROFILE_KEYS = ['version', 'sourcePurpose', 'repository', 'sourceRef', 'sourceSha', 'treeSha', 'baselineRef', 'baselineSha', 'baselineTreeSha', 'pipelinePath', 'pipelineSha256'];
// Selection must come from an independently authenticated controller caller.
// Neither these definition-only APIs nor a candidate-supplied JSON file authenticate it.
export function selectInternalCiSourceProfile(expectedSource) {
  if (expectedSource === undefined) return Object.freeze({ version: 1, repository: 'tuckerplee/LunchLineup', sourceRef: CANDIDATE_REF, baselineRef: 'refs/heads/main', pipelinePath: '.ci/pipeline.json' });
  if (!expectedSource || typeof expectedSource !== 'object' || Array.isArray(expectedSource) || Object.keys(expectedSource).length !== PROFILE_KEYS.length || PROFILE_KEYS.some(key => !Object.hasOwn(expectedSource, key))) throw new Error('Invalid explicit disposable source profile.');
  const profile = Object.fromEntries(PROFILE_KEYS.map(key => [key, expectedSource[key]]));
  const ref = profile.sourceRef;
  if (profile.version !== 2 || profile.sourcePurpose !== 'disposable-development' || profile.repository !== 'tuckerplee/LunchLineup' || typeof ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || [CANDIDATE_REF, 'refs/heads/main'].includes(ref) || ref.includes('..') || ref.includes('//') || ref.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || ref.endsWith('/') || profile.baselineRef !== 'refs/heads/main' || !['.ci/pipeline.json', '.ci/development-qa.pipeline.json', '.ci/development-browser.pipeline.json'].includes(profile.pipelinePath) || typeof profile.pipelineSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(profile.pipelineSha256) || ['sourceSha', 'treeSha', 'baselineSha', 'baselineTreeSha'].some(key => typeof profile[key] !== 'string' || !sha(profile[key])) || profile.sourceSha === profile.baselineSha) throw new Error('Invalid explicit disposable source profile.');
  return Object.freeze(profile);
}
export function internalCiSourceTrackingRef(expectedSource) {
  return `refs/remotes/origin/${selectInternalCiSourceProfile(expectedSource).sourceRef.slice('refs/heads/'.length)}`;
}
export function verifyInternalCiSourceSelection(value, expectedSource) {
  const profile = selectInternalCiSourceProfile(expectedSource);
  if (value.version !== profile.version || value.repository !== profile.repository || value.sourceRef !== profile.sourceRef || value.baselineRef !== profile.baselineRef || value[profile.version === 1 ? 'remoteCandidateSha' : 'remoteSourceSha'] !== value.sourceSha) throw new Error('Source selection mismatch.');
  if (profile.version === 2) {
    for (const key of ['sourcePurpose', 'sourceSha', 'treeSha', 'baselineSha', 'pipelinePath', 'pipelineSha256']) if (value[key] !== profile[key]) throw new Error('Source selection mismatch.');
    if (Object.hasOwn(value, 'remoteCandidateSha') || (Object.hasOwn(value, 'baselineTreeSha') && value.baselineTreeSha !== profile.baselineTreeSha)) throw new Error('Source selection mismatch.');
  } else if (['sourcePurpose', 'remoteSourceSha', 'pipelinePath'].some(key => Object.hasOwn(value, key))) throw new Error('Source selection mismatch.');
  return profile;
}
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inside = (parent, child) => { const rel = relative(realpathSync(parent), realpathSync(child)); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function assertPathInside(parent, child, name = 'path') { if (!inside(parent, child)) throw new Error(`${name} must stay inside its parent.`); }
export function assertRegularFile(path, name = 'file') { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`${name} must be a regular file.`); }
export function assertDirectory(path, name = 'directory') { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`${name} must be a directory.`); }
export function gitDirectory(clonePath) { const value = git(clonePath, 'rev-parse', '--absolute-git-dir'); const path = realpathSync(value); if (!inside(clonePath, path)) throw new Error('Git directory must be inside clone.'); return path; }
export function assertNoGitAlternates(clonePath) { if (existsSync(resolve(gitDirectory(clonePath), 'objects/info/alternates'))) throw new Error('Git alternates are forbidden.'); }
export function verifyExactClone(path, expected, { expectedSource } = {}) {
  assertDirectory(path, 'clone'); if (lstatSync(path).isSymbolicLink()) throw new Error('Clone symlink rejected.');
  const dotGit = resolve(path, '.git'); assertDirectory(dotGit, 'clone .git'); assertNoGitAlternates(path);
  execFileSync('git', ['diff', '--quiet'], { cwd: path, env: gitEnvironment }); execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: path, env: gitEnvironment });
  if (git(path, 'rev-parse', 'HEAD') !== expected.sourceSha || git(path, 'rev-parse', 'HEAD^{tree}') !== expected.treeSha || git(path, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Clone is not exact and clean.');
  const profile = selectInternalCiSourceProfile(expectedSource);
  if (profile.version === 2 && (git(path, 'rev-parse', internalCiSourceTrackingRef(expectedSource)) !== expected.sourceSha || git(path, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD' || git(path, 'rev-parse', 'refs/remotes/origin/main') !== profile.baselineSha || git(path, 'rev-parse', `${profile.baselineSha}^{tree}`) !== profile.baselineTreeSha)) throw new Error('Disposable clone tracking ref, baseline or detached HEAD mismatch.');
  return true;
}
export function verifyInternalCiSourceContextIdentity(context, identity, { expectedSource } = {}) {
  verifyInternalCiSourceSelection(context, expectedSource);
  if (!identity.commitSha || !identity.runId || !/^[A-Za-z0-9._-]+$/.test(context.runId ?? '') || context.kind !== 'lunchlineup-internal-ci-source-context' || !sha(context.sourceSha) || !sha(context.treeSha) || !sha(context.baselineSha) || !/^[a-f0-9]{64}$/.test(context.pipelineSha256 ?? '') || context.sourceSha !== identity.commitSha || context.runId !== identity.runId) throw new Error('Invalid internal CI source context.');
  return context;
}
export function verifyInternalCiSourceProof(context, proof, { expectedSource } = {}) {
  verifyInternalCiSourceSelection(context, expectedSource);
  verifyInternalCiSourceSelection(proof, expectedSource);
  if (proof.kind !== 'lunchlineup-internal-ci-source-proof' || proof.status !== 'passed' || proof.repository !== context.repository || proof.sourceRef !== context.sourceRef || proof.sourceSha !== context.sourceSha || proof.treeSha !== context.treeSha || proof.baselineRef !== context.baselineRef || proof.baselineSha !== context.baselineSha || !sha(proof.baselineTreeSha) || proof.pipelineSha256 !== context.pipelineSha256 || proof.runId !== context.runId || proof.originalCheckoutClean !== true || proof.scanCloneVerified !== true || proof.buildCloneVerified !== true || proof.gitAlternatesRejected !== true || !Number.isFinite(Date.parse(proof.verifiedAt ?? ''))) throw new Error('Source proof does not bind source context.');
  return proof;
}
export function verifyInternalCiSourceContext(context, { verifyClones = false, expectedSource, env = process.env } = {}) {
  const profile = selectInternalCiSourceProfile(expectedSource);
  verifyInternalCiSourceContextIdentity(context, { commitSha: env.CI_COMMIT_SHA, runId: env.CI_RUN_ID }, { expectedSource });
  if (profile.version === 2 && (env.CI_REF !== profile.sourceRef || env.CI_REPOSITORY !== 'lunchlineup' || env.CI_RUN_ATTEMPT !== '1')) throw new Error('Disposable controller identity mismatch.');
  assertDirectory(context.runRoot, 'run root'); assertDirectory(context.artifactRoot, 'artifact root'); assertDirectory(context.scanSourcePath, 'scan clone'); assertDirectory(context.buildSourcePath, 'build clone'); assertRegularFile(context.sourceProofPath, 'source proof');
  const expectedRunRoot = env.RUNNER_TEMP ? resolve(env.RUNNER_TEMP, `lunchlineup-source-${context.runId}`) : '';
  if (!expectedRunRoot || realpathSync(context.runRoot) !== realpathSync(expectedRunRoot) || realpathSync(context.scanSourcePath) === realpathSync(context.buildSourcePath)) throw new Error('Source context run root is not job-private.');
  assertPathInside(context.runRoot, context.scanSourcePath, 'scan clone'); assertPathInside(context.runRoot, context.buildSourcePath, 'build clone'); assertPathInside(context.artifactRoot, context.sourceProofPath, 'source proof');
  if (realpathSync(context.evidenceRoot) !== realpathSync(context.artifactRoot)) throw new Error('Evidence root must equal artifact root.');
  const proof = JSON.parse(readFileSync(context.sourceProofPath, 'utf8'));
  verifyInternalCiSourceProof(context, proof, { expectedSource });
  if (verifyClones) { verifyExactClone(context.scanSourcePath, context, { expectedSource }); verifyExactClone(context.buildSourcePath, context, { expectedSource }); }
  return context;
}
export function readInternalCiSourceContext(path, options) { assertRegularFile(path, 'source context'); return verifyInternalCiSourceContext(JSON.parse(readFileSync(path, 'utf8')), options); }
