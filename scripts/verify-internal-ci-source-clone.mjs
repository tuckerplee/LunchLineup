import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularEvidenceSnapshot } from './internal-ci-evidence.mjs';
import { verifyInternalCiSourceSelection, verifyInternalCiSourceProof, internalCiSourceTrackingRef } from './internal-ci-source-context.mjs';

// Definition-only API: expectedSource must be supplied by the protected owner.
// The CLI intentionally has no candidate-controlled disposable profile loader.
export function verifyInternalCiSourceClone({ proofPath: proofInput, clone: cloneInput, purpose, requireClean = false, expectedSource } = {}) {
  if (!proofInput || !cloneInput || typeof requireClean !== 'boolean') throw new Error('Invalid clone verification arguments.');
  const proofPath = resolve(proofInput), clone = resolve(cloneInput);
  if (!['scan', 'build'].includes(purpose) || !existsSync(proofPath) || lstatSync(proofPath).isSymbolicLink() || !statSync(proofPath).isFile() || !existsSync(clone)) throw new Error('Usage: --proof <path> --clone <path> --purpose <scan|build> [--require-clean]');
  const proof = JSON.parse(readRegularEvidenceSnapshot(proofPath, dirname(proofPath), { maxBytes: 1024 * 1024 }).bytes.toString('utf8'));
  const profile = verifyInternalCiSourceSelection(proof, expectedSource);
  if (profile.version === 2) verifyInternalCiSourceProof(proof, proof, { expectedSource });
  if (proof.kind !== 'lunchlineup-internal-ci-source-proof' || proof.status !== 'passed' || !/^[a-f0-9]{40}$/.test(proof.sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(proof.treeSha ?? '') || !/^[a-f0-9]{40}$/.test(proof.baselineSha ?? '')) throw new Error('Invalid source proof.');
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)));
  const git = (...args) => execFileSync('git', args, { cwd: clone, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gitDir = resolve(git('rev-parse', '--absolute-git-dir'));
  const gitDirRelative = relative(resolve(clone), gitDir);
  if (lstatSync(clone).isSymbolicLink() || lstatSync(resolve(clone, '.git')).isSymbolicLink() || !statSync(resolve(clone, '.git')).isDirectory() || !gitDirRelative || gitDirRelative === '..' || gitDirRelative.startsWith(`..${sep}`) || isAbsolute(gitDirRelative) || existsSync(resolve(gitDir, 'objects/info/alternates')) || git('rev-parse', 'HEAD') !== proof.sourceSha || git('rev-parse', 'HEAD^{tree}') !== proof.treeSha) throw new Error('Clone identity verification failed.');
  execFileSync('git', ['diff', '--quiet'], { cwd: clone, env: gitEnvironment }); execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: clone, env: gitEnvironment });
  if (requireClean && git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Clone contains untracked files.');
  if (profile.version === 2 && (git('rev-parse', internalCiSourceTrackingRef(expectedSource)) !== proof.sourceSha || git('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD' || git('rev-parse', 'refs/remotes/origin/main') !== profile.baselineSha || git('rev-parse', `${profile.baselineSha}^{tree}`) !== profile.baselineTreeSha)) throw new Error('Disposable clone tracking ref, baseline or detached HEAD mismatch.');
  if (purpose === 'scan') {
    execFileSync('git', ['cat-file', '-e', `${proof.baselineSha}^{commit}`], { cwd: clone, env: gitEnvironment, stdio: 'ignore' });
    if (git('rev-parse', 'refs/remotes/origin/main') !== proof.baselineSha) throw new Error('Scan baseline mismatch.');
  }
  return { purpose, sourceSha: proof.sourceSha, treeSha: proof.treeSha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--proof', '--clone', '--purpose', '--require-clean'].includes(key) || Object.hasOwn(options, key)) throw new Error('Invalid clone verification options.');
    if (key === '--require-clean') options[key] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Invalid clone verification options.'); options[key] = value; }
  }
  const result = verifyInternalCiSourceClone({ proofPath: options['--proof'], clone: options['--clone'], purpose: options['--purpose'], requireClean: options['--require-clean'] ?? false });
  console.log(`internal_ci_source_clone_ok purpose=${result.purpose} source_sha=${result.sourceSha} tree_sha=${result.treeSha}`);
}
