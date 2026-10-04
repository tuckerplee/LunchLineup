import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectInternalCiSourceProfile, internalCiSourceTrackingRef } from './internal-ci-source-context.mjs';

// The explicit profile is an API input from the protected controller adapter.
// The CLI remains candidate-only until that independently authenticated adapter exists.
export function materializeInternalCiSource({ artifactRoot: artifactInput, runRoot: runInput, workspace: workspaceInput = process.cwd(), env = process.env, expectedSource } = {}) {
  const profile = selectInternalCiSourceProfile(expectedSource);
  const sourceTrackingRef = internalCiSourceTrackingRef(expectedSource);
  const materializationStartedAt = new Date(Date.now() - 1).toISOString();
  const artifactRoot = resolve(artifactInput ?? '');
  const runRoot = resolve(runInput ?? '');
  const sha = env.CI_COMMIT_SHA ?? '', ref = env.CI_REF ?? '', runId = env.CI_RUN_ID ?? '', controllerRepository = env.CI_REPOSITORY ?? '', repository = 'tuckerplee/LunchLineup';
  const workspace = realpathSync(workspaceInput);
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const inside = (root, child, { allowEqual = false } = {}) => {
    const parent = realpathSync(root), value = realpathSync(child), r = relative(parent, value);
    return (allowEqual && r === '') || (r !== '' && !r.startsWith('..\\') && r !== '..' && !r.startsWith('../') && !r.includes('\\..\\') && !r.includes('/../'));
  };
  const assertDirectory = (path, name) => { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`${name} must be a real directory.`); };
  const assertClean = (cwd) => { execFileSync('git', ['diff', '--quiet'], { cwd, env: gitEnvironment }); execFileSync('git', ['diff', '--cached', '--quiet'], { cwd, env: gitEnvironment }); if (git(cwd, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Source is not clean.'); };
  const expectedRunRoot = env.RUNNER_TEMP ? resolve(env.RUNNER_TEMP, `lunchlineup-source-${runId}`) : '';
  const expectedArtifactRoot = resolve(workspace, '.release', 'internal-ci', sha);
  if (!/^[a-f0-9]{40}$/.test(sha) || ref !== profile.sourceRef || controllerRepository !== 'lunchlineup' || !/^[A-Za-z0-9._-]+$/.test(runId) || Number(env.CI_RUN_ATTEMPT) !== 1 || !artifactInput || !runInput || runRoot !== expectedRunRoot || artifactRoot !== expectedArtifactRoot || existsSync(runRoot) || existsSync(artifactRoot)) throw new Error('Exact identity and unused job-private --artifact-root/--run-root are required.');
  if (profile.version === 2 && env.CI_RUN_ATTEMPT !== '1') throw new Error('Disposable controller attempt mismatch.');
  const originalGitDir = realpathSync(git(workspace, 'rev-parse', '--absolute-git-dir'));
  if (existsSync(resolve(originalGitDir, 'objects/info/alternates'))) throw new Error('Original checkout Git alternates are forbidden.');
  const headSha = git(workspace, 'rev-parse', 'HEAD'), remoteSourceSha = git(workspace, 'rev-parse', sourceTrackingRef), baselineSha = git(workspace, 'rev-parse', 'refs/remotes/origin/main');
  if (headSha !== sha || remoteSourceSha !== sha) throw new Error('Candidate identity mismatch.');
  assertClean(workspace); if (baselineSha === sha) throw new Error('Baseline main must be distinct from the candidate.'); git(workspace, 'merge-base', '--is-ancestor', baselineSha, sha);
  const treeSha = git(workspace, 'rev-parse', 'HEAD^{tree}'), baselineTreeSha = git(workspace, 'rev-parse', `${baselineSha}^{tree}`), initialPipeline = createHash('sha256').update(readFileSync(resolve(workspace, profile.pipelinePath))).digest('hex');
  if (profile.version === 2 && (sha !== profile.sourceSha || treeSha !== profile.treeSha || baselineSha !== profile.baselineSha || baselineTreeSha !== profile.baselineTreeSha || initialPipeline !== profile.pipelineSha256)) throw new Error('Disposable source profile mismatch.');
  const verifiedCheckoutTransport = pathToFileURL(workspace).href;
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  assertDirectory(runRoot, 'run root');
  const realRunRoot = realpathSync(runRoot);
  const clone = (name) => {
    const path = resolve(realRunRoot, name);
    if (path !== resolve(realRunRoot, name)) throw new Error(`${name} clone escapes run root.`);
    mkdirSync(path, { mode: 0o700 });
    execFileSync('git', ['init', '--quiet', path], { env: gitEnvironment, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', verifiedCheckoutTransport], { cwd: path, env: gitEnvironment, stdio: 'ignore' });
    execFileSync('git', ['fetch', '--quiet', '--no-tags', '--force', 'origin', `+${sourceTrackingRef}:${sourceTrackingRef}`, '+refs/remotes/origin/main:refs/remotes/origin/main'], { cwd: path, env: gitEnvironment, stdio: 'ignore' });
    execFileSync('git', ['checkout', '--detach', sha], { cwd: path, env: gitEnvironment, stdio: 'ignore' });
    execFileSync('git', ['reset', '--hard', sha], { cwd: path, env: gitEnvironment, stdio: 'ignore' });
    execFileSync('git', ['clean', '-ffdx'], { cwd: path, env: gitEnvironment, stdio: 'ignore' });
    const cloneGitDir = realpathSync(git(path, 'rev-parse', '--absolute-git-dir'));
    if (lstatSync(path).isSymbolicLink() || !inside(realRunRoot, path) || !inside(path, cloneGitDir) || existsSync(resolve(cloneGitDir, 'objects/info/alternates')) || git(path, 'rev-parse', 'HEAD') !== sha || git(path, 'rev-parse', 'HEAD^{tree}') !== treeSha || git(path, 'rev-parse', sourceTrackingRef) !== sha || git(path, 'rev-parse', 'refs/remotes/origin/main') !== baselineSha) throw new Error(`${name} clone verification failed.`);
    assertClean(path); return realpathSync(path);
  };
  const scanClonePath = clone('scan'), buildClonePath = clone('build');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const realArtifactRoot = realpathSync(artifactRoot);
  if (scanClonePath === buildClonePath || inside(scanClonePath, realArtifactRoot, { allowEqual: true }) || inside(buildClonePath, realArtifactRoot, { allowEqual: true })) throw new Error('Clone and artifact boundaries overlap.');
  const finalPipeline = createHash('sha256').update(readFileSync(resolve(workspace, profile.pipelinePath))).digest('hex'); if (initialPipeline !== finalPipeline) throw new Error('Pipeline changed during materialization.');
  mkdirSync(resolve(realArtifactRoot, 'source'), { recursive: true, mode: 0o700 });
  const proof = { version: profile.version, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', repository, ...(profile.version === 2 ? { sourcePurpose: profile.sourcePurpose } : {}), sourceRef: ref, sourceSha: sha, ...(profile.version === 1 ? { remoteCandidateSha: remoteSourceSha } : { remoteSourceSha }), treeSha, baselineRef: 'refs/heads/main', baselineSha, baselineTreeSha, ...(profile.version === 2 ? { pipelinePath: profile.pipelinePath } : {}), pipelineSha256: initialPipeline, runId, originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: new Date().toISOString() };
  const proofBytes = `${JSON.stringify(proof, null, 2)}\n`, proofPath = resolve(realArtifactRoot, 'source/source-proof.json');
  writeFileSync(proofPath, proofBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(resolve(realRunRoot, 'source-context.json'), `${JSON.stringify({ version: profile.version, kind: 'lunchlineup-internal-ci-source-context', repository, ...(profile.version === 2 ? { sourcePurpose: profile.sourcePurpose } : {}), runId, runRoot: realRunRoot, sourceRef: ref, sourceSha: sha, treeSha, ...(profile.version === 1 ? { remoteCandidateSha: remoteSourceSha } : { remoteSourceSha }), baselineRef: 'refs/heads/main', baselineSha, ...(profile.version === 2 ? { pipelinePath: profile.pipelinePath } : {}), pipelineSha256: initialPipeline, sourceProofPath: resolve(realArtifactRoot, 'source/source-proof.json'), scanSourcePath: scanClonePath, buildSourcePath: buildClonePath, artifactRoot: realArtifactRoot, evidenceRoot: realArtifactRoot }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  mkdirSync(resolve(realArtifactRoot, 'gates'), { recursive: true, mode: 0o700 });
  const completedAt = new Date().toISOString(), proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
  writeFileSync(resolve(realArtifactRoot, 'gates/source-identity.json'), `${JSON.stringify({ version: 2, kind: 'lunchlineup-internal-ci-gate', name: 'source-identity', status: 'passed', repository, runId, sourceRef: ref, sourceSha: sha, treeSha, baselineSha, ...(profile.version === 2 ? { pipelinePath: profile.pipelinePath } : {}), pipelineSha256: initialPipeline, sourceProofSha256: proofSha256, sourceProof: 'source/source-proof.json', attempt: Number(env.CI_RUN_ATTEMPT), startedAt: materializationStartedAt, completedAt, evidence: [{ path: 'source/source-proof.json', sha256: proofSha256, bytes: Buffer.byteLength(proofBytes) }], details: { originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { proofPath, contextPath: resolve(realRunRoot, 'source-context.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--artifact-root', '--run-root'].includes(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Usage: --artifact-root <path> --run-root <path>; disposable source requires the authenticated controller API.');
    options[key] = value;
  }
  materializeInternalCiSource({ artifactRoot: options['--artifact-root'], runRoot: options['--run-root'] });
}
