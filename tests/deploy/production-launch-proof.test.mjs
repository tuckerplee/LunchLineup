import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDeploymentContract } from '../../scripts/write-deployment-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const publicBuildConfigKeys = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_OIDC_ENABLED',
  'NEXT_PUBLIC_SIGNUP_MODE',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL',
  'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL',
  'NEXT_PUBLIC_DPA_CONTACT_EMAIL',
  'NEXT_PUBLIC_APP_ORIGIN',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_APP_ENV',
];
const publicBuildConfigValues = {
  NEXT_PUBLIC_API_URL: '/api/v1',
  NEXT_PUBLIC_OIDC_ENABLED: 'false',
  NEXT_PUBLIC_SIGNUP_MODE: 'closed_beta',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
  NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: 'privacy@lunchlineup.com',
  NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.com',
  NEXT_PUBLIC_DPA_CONTACT_EMAIL: 'dpa@lunchlineup.com',
  NEXT_PUBLIC_APP_ORIGIN: 'https://lunchlineup.com',
  NEXT_PUBLIC_APP_URL: 'https://lunchlineup.com',
  NEXT_PUBLIC_APP_ENV: 'production',
};

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function samplePublicBuildConfig() {
  const canonical = JSON.stringify({ keys: publicBuildConfigKeys, values: publicBuildConfigValues });
  return {
    sha256: createHash('sha256').update(canonical).digest('hex'),
    keys: publicBuildConfigKeys,
    values: publicBuildConfigValues,
  };
}

function sampleReleaseManifest() {
  const services = {
    api: 'Dockerfile.api',
    web: 'Dockerfile.web',
    engine: 'Dockerfile.engine',
    worker: 'Dockerfile.worker',
    migrate: 'Dockerfile.migrations',
    control: 'Dockerfile.control',
    backup: 'Dockerfile.backup',
  };

  return {
    version: 1,
    sourceSha,
    imagePrefix: 'ghcr.io/tuckerplee/lunchlineup',
    workflowRun: 'https://github.com/tuckerplee/lunchlineup/actions/runs/1',
    publicBuildConfig: samplePublicBuildConfig(),
    productionHealthProof: {
      domain: 'lunchlineup.com',
      url: 'https://lunchlineup.com/api/health',
    },
    deploymentContract: buildDeploymentContract(root),
    images: Object.fromEntries(
      Object.entries(services).map(([service, dockerfile], index) => {
        const digest = `sha256:${String(index + 1).repeat(64)}`;
        return [
          service,
          {
            ref: `ghcr.io/tuckerplee/lunchlineup/${service}:${sourceSha}@${digest}`,
            digest,
            dockerfile: `infrastructure/docker/${dockerfile}`,
          },
        ];
      }),
    ),
  };
}

function sampleLaunchProof() {
  const checkedAt = new Date().toISOString();
  const entry = (uri, summary, command, artifactDigit) => ({
    status: 'passed',
    sourceSha,
    uri,
    checkedAt,
    summary,
    command,
    exitCode: 0,
    artifactSha256: artifactDigit.repeat(64),
    artifactBytes: 2048,
  });

  return {
    version: 1,
    sourceSha,
    generatedAt: checkedAt,
    evidence: {
      runtimeEnv: entry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/110',
        'Production runtime environment validation passed with retained output',
        'node scripts/validate-production-launch.mjs /tmp/production-runtime.env',
        '1',
      ),
      dast: entry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/111',
        'DAST baseline completed with no launch-blocking findings',
        'scripts/run-dast.sh https://lunchlineup.com',
        '2',
      ),
      load: entry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/112',
        'Load smoke completed against the release image stack',
        'scripts/load-test.sh https://lunchlineup.com',
        '3',
      ),
      drDrill: {
        ...entry(
          's3://lunchlineup-prod/launch-proof/dr-drill-20260709.json',
          'Off-host encrypted backup restored into the disposable DR drill database',
          'BACKUP_FILE=/tmp/lunchlineup-20260709000000.sql.zst.gpg DR_OFFHOST_SOURCE_URI=s3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg ./scripts/dr-drill.sh',
          '4',
        ),
        backupSha256: 'a'.repeat(64),
        restoredTableCount: 42,
        sourceUri: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
      },
      pitrDrill: {
        ...entry(
          's3://lunchlineup-prod/launch-proof/pitr-drill-20260709.json',
          'Named COMPLETE base backup and archived WAL restored with invariants passing',
          'PITR_BASE_BACKUP_ID=20260709T010000Z-1234 ./scripts/pitr-restore.sh && ./ops/check-pitr-invariants',
          '7',
        ),
        baseBackupId: '20260709T010000Z-1234',
        baseBackupUri: 's3://lunchlineup-prod/postgres/basebackups/20260709T010000Z-1234/COMPLETE',
        archivedWalSegment: '00000001000000000000002A',
        archivedWalUri: 's3://lunchlineup-prod/postgres/wal/00000001000000000000002A',
        recoveryTargetTime: checkedAt,
        sourceTimestamp: checkedAt,
      },
      alertRoute: entry(
        'https://pagerduty.com/incidents/ABC123',
        'Production critical alert route delivered to the paging target',
        'amtool alert add ServiceDown severity=critical',
        '5',
      ),
    },
  };
}

function writePolicyFixture(scratch) {
  const dockerfileDir = join(scratch, 'docker');
  const composePath = join(scratch, 'docker-compose.yml');
  const workflowPath = join(scratch, 'ci.yml');

  mkdirSync(dockerfileDir, { recursive: true });
  writeFileSync(
    join(dockerfileDir, 'Dockerfile.api'),
    'FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2\n',
  );
  writeFileSync(
    composePath,
    'services:\n  postgres:\n    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777\n',
  );
  writeFileSync(
    workflowPath,
    read('.github/workflows/ci.yml'),
  );

  return ['--dockerfile-dir', dockerfileDir, '--compose-file', composePath, '--workflow-file', workflowPath];
}

function runVerifier(args, env = {}) {
  return spawnSync(process.execPath, ['scripts/verify-production-launch-proof.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('production launch proof verifier accepts retained proof and rejects missing or placeholder proof', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-production-proof-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const proofPath = join(scratch, 'launch-proof.json');

  try {
    writeFileSync(manifestPath, `${JSON.stringify(sampleReleaseManifest(), null, 2)}\n`);
    writeFileSync(proofPath, `${JSON.stringify(sampleLaunchProof(), null, 2)}\n`);
    const policyArgs = writePolicyFixture(scratch);

    const valid = runVerifier([
      manifestPath,
      proofPath,
      '--source-sha',
      sourceSha,
      ...policyArgs,
    ]);
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /release_artifacts_ok/);
    assert.match(valid.stdout, /production_launch_proof_ok/);
    assert.match(valid.stdout, /sha256=[a-f0-9]{64}/);
    assert.match(valid.stdout, /bytes=[1-9][0-9]*/);

    const spoofedExternalPath = join(scratch, 'spoofed-external-launch-proof.json');
    const spoofedExternal = sampleLaunchProof();
    spoofedExternal.evidence.externalHealth = {
      status: 'passed',
      sourceSha,
      uri: 'https://status.lunchlineup.com/checks/spoofed-candidate.json',
      checkedAt: spoofedExternal.generatedAt,
      summary: 'Old production response relabeled as the candidate release health proof',
      command: 'curl -fsS https://lunchlineup.com/api/health',
      exitCode: 0,
      artifactSha256: '9'.repeat(64),
      artifactBytes: 100,
      healthUrl: 'https://lunchlineup.com/api/health',
      httpStatus: 200,
    };
    writeFileSync(spoofedExternalPath, `${JSON.stringify(spoofedExternal, null, 2)}\n`);
    const spoofed = runVerifier([manifestPath, spoofedExternalPath, '--source-sha', sourceSha, ...policyArgs]);
    assert.notEqual(spoofed.status, 0);
    assert.match(spoofed.stderr, /must not contain externalHealth/);

    const missing = runVerifier([manifestPath, join(scratch, 'missing-launch-proof.json'), '--source-sha', sourceSha, ...policyArgs]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Launch proof file is required/);

    const placeholderProofPath = join(scratch, 'placeholder-launch-proof.json');
    const placeholderProof = sampleLaunchProof();
    placeholderProof.evidence.dast.uri = 'https://github.com/tuckerplee/lunchlineup/actions/runs/<run-id>/artifacts/<artifact-id>';
    writeFileSync(placeholderProofPath, `${JSON.stringify(placeholderProof, null, 2)}\n`);

    const placeholder = runVerifier([manifestPath, placeholderProofPath, '--source-sha', sourceSha, ...policyArgs]);
    assert.notEqual(placeholder.status, 0);
    assert.match(placeholder.stderr, /Launch proof contains placeholder/);
    assert.match(placeholder.stderr, /launchProof\.evidence\.dast\.uri/);

    const template = runVerifier([
      manifestPath,
      join(root, 'docs/testing/launch-proof-template.json'),
      '--source-sha',
      sourceSha,
      ...policyArgs,
    ]);
    assert.notEqual(template.status, 0);
    assert.match(template.stderr, /Launch proof contains placeholder/);
    assert.match(template.stderr, /launchProof\.sourceSha/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production launch proof verifier rejects stale and future evidence', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-production-proof-freshness-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const proofPath = join(scratch, 'launch-proof.json');
  const verificationTime = '2026-07-09T12:00:00.000Z';

  try {
    writeFileSync(manifestPath, `${JSON.stringify(sampleReleaseManifest(), null, 2)}\n`);
    const policyArgs = writePolicyFixture(scratch);

    const staleProof = sampleLaunchProof();
    staleProof.generatedAt = '2026-07-08T11:59:59.000Z';
    for (const entry of Object.values(staleProof.evidence)) {
      entry.checkedAt = staleProof.generatedAt;
    }
    writeFileSync(proofPath, `${JSON.stringify(staleProof, null, 2)}\n`);
    const stale = runVerifier([
      manifestPath,
      proofPath,
      '--source-sha',
      sourceSha,
      '--verification-time',
      verificationTime,
      '--max-proof-age-seconds',
      '86400',
      ...policyArgs,
    ]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /exceeds the maximum launch-proof age/);

    const multiDayRollback = runVerifier([
      manifestPath,
      proofPath,
      '--source-sha',
      sourceSha,
      '--verification-time',
      '2026-08-09T12:00:00.000Z',
      '--max-proof-age-seconds',
      '86400',
      '--launch-proof-mode',
      'rollback',
      ...policyArgs,
    ]);
    assert.equal(multiDayRollback.status, 0, `${multiDayRollback.stdout}\n${multiDayRollback.stderr}`);
    assert.match(multiDayRollback.stdout, /launch_proof=rollback/);

    const futureProof = sampleLaunchProof();
    futureProof.generatedAt = '2026-07-09T12:05:01.000Z';
    for (const entry of Object.values(futureProof.evidence)) {
      entry.checkedAt = futureProof.generatedAt;
    }
    writeFileSync(proofPath, `${JSON.stringify(futureProof, null, 2)}\n`);
    const future = runVerifier([
      manifestPath,
      proofPath,
      '--source-sha',
      sourceSha,
      '--verification-time',
      verificationTime,
      '--max-proof-age-seconds',
      '86400',
      ...policyArgs,
    ]);
    assert.notEqual(future.status, 0);
    assert.match(future.stderr, /more than five minutes in the future/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production launch proof keeps the recovery bearer out of provider argv and child environment', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-production-proof-bearer-'));
  const fakeBin = join(scratch, 'bin');
  const manifestPath = join(scratch, 'release-manifest.json');
  const proofPath = join(scratch, 'launch-proof.json');
  const argvLog = join(scratch, 'curl-argv.log');
  const channelProof = join(scratch, 'curl-channel-ok');
  const providerEnvironment = join(scratch, 'provider-environment.sh');
  const bearer = 'RECOVERY-BEARER-ARGV-SENTINEL-7f4f9d';

  try {
    mkdirSync(fakeBin);
    writeFileSync(manifestPath, `${JSON.stringify(sampleReleaseManifest(), null, 2)}\n`);
    writeFileSync(proofPath, `${JSON.stringify(sampleLaunchProof(), null, 2)}\n`);
    writeFileSync(providerEnvironment, `PATH='${bashPath(fakeBin)}':$PATH\nexport PATH\n`);
    const policyArgs = writePolicyFixture(scratch);
    writeExecutable(join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'started\\n' >'${bashPath(channelProof)}'
if [[ -r /proc/$$/cmdline ]]; then
  tr '\\000' '\\n' </proc/$$/cmdline >'${bashPath(argvLog)}'
else
  printf '%s\\n' "$@" >'${bashPath(argvLog)}'
fi
[[ -z "\${LAUNCH_PROOF_HTTP_BEARER_TOKEN:-}" ]]
printf 'env-ok\\n' >'${bashPath(channelProof)}'
config=''
while (( $# > 0 )); do
  if [[ "$1" == '--config' ]]; then config="$2"; shift 2; else shift; fi
done
[[ -n "$config" ]]
printf 'config-ok\\n' >'${bashPath(channelProof)}'
if command -v cygpath >/dev/null 2>&1; then config="$(cygpath -u "$config")"; fi
${process.platform === 'win32' ? ':' : '[[ "$(stat -c \'%a\' "$config")" == \'600\' ]]'}
grep -Fq 'Authorization: Bearer ${bearer}' "$config"
printf 'ok\\n' >'${bashPath(channelProof)}'
exit 79
`);

    const result = runVerifier([
      manifestPath,
      proofPath,
      '--fetch-evidence',
      '--source-sha',
      sourceSha,
      ...policyArgs,
    ], {
      LAUNCH_PROOF_HTTP_BEARER_TOKEN: bearer,
      BASH_ENV: bashPath(providerEnvironment),
      ...(process.platform === 'win32' ? { BACKUP_PROVIDER_OWNERSHIP_MODE: 'container-job' } : {}),
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unable to retrieve launchProof\.evidence\.runtimeEnv\.uri/);
    assert.equal(readFileSync(channelProof, 'utf8'), 'ok\n');
    const childArgv = readFileSync(argvLog, 'utf8');
    assert.doesNotMatch(childArgv, new RegExp(bearer));
    assert.doesNotMatch(childArgv, /Authorization: Bearer/);
    assert.match(childArgv, /--config/);
    assert.match(read('scripts/verify-production-launch-proof.mjs'), /writeFileSync\(curlConfigPath,[\s\S]*mode: 0o600/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production workflow requires launch proof before production deploy mutation', () => {
  const ci = read('.github/workflows/ci.yml');
  const proofGateIndex = ci.indexOf('Verify production launch proof artifact');
  const deployIndex = ci.indexOf('name: "17. Guarded production deploy;');

  assert.notEqual(proofGateIndex, -1);
  assert.notEqual(deployIndex, -1);
  assert.ok(proofGateIndex < deployIndex);
  assert.match(ci, /PRODUCTION_LAUNCH_PROOF_B64: \$\{\{ secrets\.PRODUCTION_LAUNCH_PROOF_B64 \}\}/);
  assert.match(ci, /PRODUCTION_LAUNCH_PROOF_B64 must contain the base64-encoded \.release\/launch-proof\.json/);
  assert.match(ci, /base64 -d > "\$launch_proof"/);
  assert.match(ci, /node scripts\/verify-production-launch-proof\.mjs \.release\/release-manifest\.json "\$launch_proof"/);
  assert.match(ci, /--fetch-evidence/);
  assert.match(ci, /LAUNCH_PROOF_HTTP_BEARER_TOKEN/);
  assert.doesNotMatch(ci, /--command-env PRODUCTION_DEPLOY_COMMAND|PRODUCTION_DEPLOY_COMMAND:/);
  assert.equal((ci.match(/bash scripts\/deploy-vm217-transport\.sh/g) ?? []).length >= 2, true);
  const automaticProduction = ci.slice(
    ci.indexOf('  deploy-production:'),
    ci.indexOf('  # --- SBOM Generation ---'),
  );
  assert.equal((automaticProduction.match(/--launch-proof-mode rollback/g) ?? []).length, 2);
  const verifier = read('scripts/verify-production-launch-proof.mjs');
  assert.match(verifier, /fetchEvidenceBytes/);
  assert.match(verifier, /artifactSha256 does not match the retrieved evidence bytes/);
  assert.match(verifier, /artifactBytes does not match the retrieved evidence size/);
  assert.doesNotMatch(verifier, /commandArgs\.push\('--header'/);
  assert.match(verifier, /delete providerEnv\.LAUNCH_PROOF_HTTP_BEARER_TOKEN/);
  assert.match(verifier, /cleanup_container_id_absent/);
  assert.match(read('scripts/launch-proof-evidence.mjs'), /key === 'pitrDrill'/);
});

test('launch proof docs keep the template and local verification command checkable', () => {
  const testingDocs = read('docs/testing/README.md');
  const productionRunbook = read('docs/runbooks/production-readiness.md');

  assert.match(testingDocs, /launch-proof-template\.json/);
  assert.match(testingDocs, /node scripts\/verify-release-artifacts\.mjs \.release\/release-manifest\.json --source-sha "\$GITHUB_SHA" --launch-proof-file \.release\/launch-proof\.json/);
  assert.match(productionRunbook, /docs\/testing\/launch-proof-template\.json|launch-proof-template\.json/);
  assert.match(productionRunbook, /node scripts\/verify-release-artifacts\.mjs \.release\/release-manifest\.json/);
  assert.match(productionRunbook, /--launch-proof-file \.release\/launch-proof\.json/);
});
