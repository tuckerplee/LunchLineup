import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inside = (parent, child) => { const rel = relative(realpathSync(parent), realpathSync(child)); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function assertPathInside(parent, child, name = 'path') { if (!inside(parent, child)) throw new Error(`${name} must stay inside its parent.`); }
export function assertRegularFile(path, name = 'file') { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`${name} must be a regular file.`); }
export function assertDirectory(path, name = 'directory') { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`${name} must be a directory.`); }
export function gitDirectory(clonePath) { const value = git(clonePath, 'rev-parse', '--absolute-git-dir'); const path = realpathSync(value); if (!inside(clonePath, path)) throw new Error('Git directory must be inside clone.'); return path; }
export function assertNoGitAlternates(clonePath) { if (existsSync(resolve(gitDirectory(clonePath), 'objects/info/alternates'))) throw new Error('Git alternates are forbidden.'); }
export function verifyExactClone(path, expected) {
  assertDirectory(path, 'clone'); if (lstatSync(path).isSymbolicLink()) throw new Error('Clone symlink rejected.');
  const dotGit = resolve(path, '.git'); assertDirectory(dotGit, 'clone .git'); assertNoGitAlternates(path);
  execFileSync('git', ['diff', '--quiet'], { cwd: path, env: gitEnvironment }); execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: path, env: gitEnvironment });
  if (git(path, 'rev-parse', 'HEAD') !== expected.sourceSha || git(path, 'rev-parse', 'HEAD^{tree}') !== expected.treeSha || git(path, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Clone is not exact and clean.');
  return true;
}
export function verifyInternalCiSourceContext(context, { verifyClones = false } = {}) {
  if (!process.env.CI_COMMIT_SHA || !process.env.CI_RUN_ID || !/^[A-Za-z0-9._-]+$/.test(context.runId ?? '') || context.version !== 1 || context.kind !== 'lunchlineup-internal-ci-source-context' || context.repository !== 'tuckerplee/LunchLineup' || context.sourceRef !== 'refs/heads/internal-beta-candidate' || context.baselineRef !== 'refs/heads/main' || !sha(context.sourceSha) || !sha(context.treeSha) || !sha(context.baselineSha) || !/^[a-f0-9]{64}$/.test(context.pipelineSha256 ?? '') || context.sourceSha !== context.remoteCandidateSha || context.sourceSha !== process.env.CI_COMMIT_SHA || context.runId !== process.env.CI_RUN_ID) throw new Error('Invalid internal CI source context.');
  assertDirectory(context.runRoot, 'run root'); assertDirectory(context.artifactRoot, 'artifact root'); assertDirectory(context.scanSourcePath, 'scan clone'); assertDirectory(context.buildSourcePath, 'build clone'); assertRegularFile(context.sourceProofPath, 'source proof');
  const expectedRunRoot = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP, `lunchlineup-source-${context.runId}`) : '';
  if (!expectedRunRoot || realpathSync(context.runRoot) !== realpathSync(expectedRunRoot) || realpathSync(context.scanSourcePath) === realpathSync(context.buildSourcePath)) throw new Error('Source context run root is not job-private.');
  assertPathInside(context.runRoot, context.scanSourcePath, 'scan clone'); assertPathInside(context.runRoot, context.buildSourcePath, 'build clone'); assertPathInside(context.artifactRoot, context.sourceProofPath, 'source proof');
  if (realpathSync(context.evidenceRoot) !== realpathSync(context.artifactRoot)) throw new Error('Evidence root must equal artifact root.');
  const proof = JSON.parse(readFileSync(context.sourceProofPath, 'utf8'));
  if (proof.version !== 1 || proof.kind !== 'lunchlineup-internal-ci-source-proof' || proof.status !== 'passed' || proof.repository !== context.repository || proof.sourceRef !== context.sourceRef || proof.sourceSha !== context.sourceSha || proof.remoteCandidateSha !== context.sourceSha || proof.treeSha !== context.treeSha || proof.baselineRef !== context.baselineRef || proof.baselineSha !== context.baselineSha || !sha(proof.baselineTreeSha) || proof.pipelineSha256 !== context.pipelineSha256 || proof.runId !== context.runId || proof.originalCheckoutClean !== true || proof.scanCloneVerified !== true || proof.buildCloneVerified !== true || proof.gitAlternatesRejected !== true || !Number.isFinite(Date.parse(proof.verifiedAt ?? ''))) throw new Error('Source proof does not bind source context.');
  if (verifyClones) { verifyExactClone(context.scanSourcePath, context); verifyExactClone(context.buildSourcePath, context); }
  return context;
}
export function readInternalCiSourceContext(path, options) { assertRegularFile(path, 'source context'); return verifyInternalCiSourceContext(JSON.parse(readFileSync(path, 'utf8')), options); }
