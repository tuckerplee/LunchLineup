import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function exists(path) {
  return existsSync(join(root, path));
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

function findBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    return existsSync(gitBash) ? gitBash : undefined;
  }
  return commandWorks('bash', ['--version']) ? 'bash' : undefined;
}

function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  return candidates.find((candidate) => commandWorks(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']));
}

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createGitFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-deploy-source-'));
  const remote = join(scratch, 'remote.git');
  const repo = join(scratch, 'repo');

  git(['init', '--bare', remote], scratch);
  git(['init', repo], scratch);
  git(['config', 'user.email', 'ci@example.com'], repo);
  git(['config', 'user.name', 'CI Fixture'], repo);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  writeFileSync(join(repo, '.gitignore'), 'DEPLOYED_GIT_SHA\n.release/\n');
  git(['add', 'README.md', '.gitignore'], repo);
  git(['commit', '-m', 'initial'], repo);
  git(['branch', '-M', 'main'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', '-u', 'origin', 'main'], repo);

  return { scratch, repo };
}

function runScript(runner, repo, env = {}) {
  const childEnv = { ...process.env };
  for (const name of ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_SHA']) {
    delete childEnv[name];
  }

  return spawnSync(runner.command, runner.args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...childEnv, ...env },
  });
}

const bashPath = findBash();
const powerShellPath = findPowerShell();
const runners = [
  bashPath && {
    name: 'shell',
    command: bashPath,
    args: [join(root, 'scripts/verify-deploy-source.sh')],
  },
  powerShellPath && {
    name: 'PowerShell',
    command: powerShellPath,
    args: [
      '-NoProfile',
      ...(powerShellPath.toLowerCase().includes('powershell') ? ['-ExecutionPolicy', 'Bypass'] : []),
      '-File',
      join(root, 'scripts/verify-deploy-source.ps1'),
    ],
  },
].filter(Boolean);

test('deploy-source verification scripts exist for Windows and Linux operators', () => {
  assert.equal(exists('scripts/verify-deploy-source.ps1'), true);
  assert.equal(exists('scripts/verify-deploy-source.sh'), true);
  assert.equal(exists('scripts/bootstrap-vm107-dev.sh'), true);
});

test('deploy-source scripts require clean Git state and upstream push proof', () => {
  const ps1 = read('scripts/verify-deploy-source.ps1');
  const sh = read('scripts/verify-deploy-source.sh');
  const gitignore = read('.gitignore');

  for (const script of [ps1, sh]) {
    assert.match(script, /git status/);
    assert.match(script, /rev-parse/);
    assert.match(script, /@{u}/);
    assert.match(script, /DEPLOYED_GIT_SHA/);
  }
  assert.match(gitignore, /^\.release\/$/m);
});

test('VM217 production deploy uses release artifacts and source helpers are development-scoped', () => {
  const rsync = read('scripts/rsync-vm217.sh');
  const remoteDeploy = read('scripts/deploy-vm217-remote.sh');
  const setup = read('scripts/setup-vm217.sh');
  const scriptsReadme = read('scripts/README.md');

  assert.match(rsync, /Refusing VM217 rsync source deploy outside development/);
  assert.match(rsync, /VM217_DEPLOY_SCOPE=development DEPLOY_SOURCE_SHA=\$\{current_sha\}/);
  assert.match(rsync, /git -C "\$ROOT_DIR" status --porcelain/);
  assert.match(rsync, /git -C "\$ROOT_DIR" rev-parse '@\{u\}'/);
  assert.match(setup, /Refusing VM217 setup outside development/);
  assert.match(setup, /BRANCH="\$\{BRANCH:-main\}"/);
  assert.match(setup, /git rev-parse HEAD > DEPLOYED_GIT_SHA/);

  assert.match(remoteDeploy, /DEPLOY_SCOPE="\$\{VM217_DEPLOY_SCOPE:-production\}"/);
  assert.match(remoteDeploy, /RELEASE_MANIFEST_PATH/);
  assert.match(remoteDeploy, /RELEASE_SOURCE_SHA/);
  assert.match(remoteDeploy, /PRODUCTION_RUNTIME_ENV_SHA256/);
  assert.match(remoteDeploy, /PRODUCTION_API_HEALTH_URL/);
  assert.match(remoteDeploy, /LAUNCH_PROOF_MANIFEST_URI/);
  assert.match(remoteDeploy, /docker pull "\$ref"/);
  assert.match(remoteDeploy, /docker tag "\$ref" "\$COMPOSE_IMAGE_PREFIX\/\$service:\$SOURCE_SHA"/);
  assert.match(remoteDeploy, /up -d --no-build --pull never/);
  assert.match(remoteDeploy, /commit_release_pointers/);
  assert.match(remoteDeploy, /write_post_deploy_proof[\s\S]*commit_release_pointers/);
  assert.match(remoteDeploy, /post_deploy_proof_ok/);
  assert.match(scriptsReadme, /VM217_DEPLOY_SCOPE=development/);
  assert.match(scriptsReadme, /--no-build --pull never/);
});

for (const runner of runners) {
  test(`${runner.name} deploy-source script accepts a clean pushed fixture`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      const result = runScript(runner, repo);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /deploy_source_ok/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script accepts ignored release manifest artifacts`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      mkdirSync(join(repo, '.release'));
      writeFileSync(join(repo, '.release', 'release-manifest.json'), '{"source":"ci"}\n');
      const result = runScript(runner, repo);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /deploy_source_ok/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script accepts a detached GitHub Actions pushed fixture`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      git(['checkout', '--detach', currentSha], repo);

      const result = runScript(runner, repo, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: currentSha,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /deploy_source_ok/);
      assert.match(result.stdout, /upstream=refs\/heads\/main/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script rejects non-push GitHub Actions events`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const result = runScript(runner, repo, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: currentSha,
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /requires a push event/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script rejects dirty state`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
      const result = runScript(runner, repo);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /dirty/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script rejects unpushed HEAD`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      writeFileSync(join(repo, 'README.md'), 'fixture\nchanged\n');
      git(['add', 'README.md'], repo);
      git(['commit', '-m', 'unpushed'], repo);

      const result = runScript(runner, repo);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /does not match upstream/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`${runner.name} deploy-source script rejects deployed SHA mismatch`, () => {
    const { scratch, repo } = createGitFixture();
    try {
      writeFileSync(join(repo, 'DEPLOYED_GIT_SHA'), 'deadbeef\n');
      const result = runScript(runner, repo);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /DEPLOYED_GIT_SHA/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test('deployment docs keep GitHub and server artifact discipline explicit', () => {
  const doc = read('docs/testing/README.md');
  assert.match(doc, /server deploy/i);
  assert.match(doc, /GitHub/i);
  assert.match(doc, /DEPLOYED_GIT_SHA/);
});

test('disposable VM107 restore is documented and tied to GitHub deploy proof', () => {
  const script = read('scripts/bootstrap-vm107-dev.sh');
  const runbook = read('docs/runbooks/disposable-dev-server.md');
  const runbooksReadme = read('docs/runbooks/README.md');
  const scriptsReadme = read('scripts/README.md');

  assert.match(script, /migration-testing-baseline/);
  assert.match(script, /DEPLOYED_GIT_SHA/);
  assert.match(script, /BACKUP_FILE/);
  assert.match(script, /dev\.lunchlineup\.com/);
  assert.match(script, /current public production ProxmoxS VM4014/);
  assert.match(script, /VM106 identifies.*historical legacy PHP source/s);
  assert.match(runbook, /15 minutes/i);
  assert.match(runbook, /GitHub/i);
  assert.match(runbook, /DEPLOYED_GIT_SHA/);
  assert.match(runbook, /current public production ProxmoxS VM4014/);
  assert.match(runbook, /VM217 is the repository's future production architecture identifier/);
  assert.match(runbook, /VM106 is the historical legacy PHP source identity/);
  assert.match(runbooksReadme, /disposable-dev-server\.md/);
  assert.match(scriptsReadme, /bootstrap-vm107-dev\.sh/);
});
