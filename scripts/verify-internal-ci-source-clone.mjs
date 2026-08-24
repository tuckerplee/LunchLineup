import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i < 0 ? '' : argv[i + 1] ?? ''; };
const proofPath = resolve(option('--proof')), clone = resolve(option('--clone')), purpose = option('--purpose');
if (!['scan', 'build'].includes(purpose) || !existsSync(proofPath) || lstatSync(proofPath).isSymbolicLink() || !statSync(proofPath).isFile() || !existsSync(clone)) throw new Error('Usage: --proof <path> --clone <path> --purpose <scan|build> [--require-clean]');
const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
if (proof.version !== 1 || proof.kind !== 'lunchlineup-internal-ci-source-proof' || proof.status !== 'passed' || proof.repository !== 'tuckerplee/LunchLineup' || proof.sourceRef !== 'refs/heads/internal-beta-candidate' || !/^[a-f0-9]{40}$/.test(proof.sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(proof.treeSha ?? '') || proof.remoteCandidateSha !== proof.sourceSha || !/^[a-f0-9]{40}$/.test(proof.baselineSha ?? '')) throw new Error('Invalid source proof.');
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)));
const git = (...args) => execFileSync('git', args, { cwd: clone, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitDir = resolve(git('rev-parse', '--absolute-git-dir'));
const gitDirRelative = relative(resolve(clone), gitDir);
if (lstatSync(clone).isSymbolicLink() || lstatSync(resolve(clone, '.git')).isSymbolicLink() || !statSync(resolve(clone, '.git')).isDirectory() || !gitDirRelative || gitDirRelative === '..' || gitDirRelative.startsWith(`..${sep}`) || isAbsolute(gitDirRelative) || existsSync(resolve(gitDir, 'objects/info/alternates')) || git('rev-parse', 'HEAD') !== proof.sourceSha || git('rev-parse', 'HEAD^{tree}') !== proof.treeSha) throw new Error('Clone identity verification failed.');
execFileSync('git', ['diff', '--quiet'], { cwd: clone, env: gitEnvironment }); execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: clone, env: gitEnvironment });
if (argv.includes('--require-clean') && git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Clone contains untracked files.');
if (purpose === 'scan') {
  execFileSync('git', ['cat-file', '-e', `${proof.baselineSha}^{commit}`], { cwd: clone, env: gitEnvironment, stdio: 'ignore' });
  if (git('rev-parse', 'refs/remotes/origin/main') !== proof.baselineSha) throw new Error('Scan baseline mismatch.');
}
console.log(`internal_ci_source_clone_ok purpose=${purpose} source_sha=${proof.sourceSha} tree_sha=${proof.treeSha}`);
