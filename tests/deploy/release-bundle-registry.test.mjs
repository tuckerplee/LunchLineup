import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { verifyOldReleaseCompatibility } from '../../scripts/verify-old-release-compatibility.mjs';
import { writeReleaseIndex } from '../../scripts/signed-release-authenticity.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sha = 'a'.repeat(40);
const certificateIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const oidcIssuer = 'https://token.actions.githubusercontent.com';
const { privateKey: fixturePrivateKey, publicKey: fixturePublicKey } = generateKeyPairSync('ed25519');
const fixturePublicKeyPem = fixturePublicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifierFixtureRoot = mkdtempSync(join(tmpdir(), 'll-fake-cosign-'));
const fakeCosignPath = join(verifierFixtureRoot, 'fake-cosign.mjs');
writeFileSync(fakeCosignPath, `
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] !== 'verify-blob' || !args[1]) process.exit(2);
const artifact = readFileSync(args[1]);
const bundle = JSON.parse(readFileSync(option('--bundle'), 'utf8'));
const digest = createHash('sha256').update(artifact).digest('hex');
const payload = {
  artifactSha256: bundle.artifactSha256,
  certificateIdentity: bundle.certificateIdentity,
  oidcIssuer: bundle.oidcIssuer,
};
const cryptographicallyValid = verify(
  null,
  Buffer.from(JSON.stringify(payload)),
  createPublicKey(process.env.TEST_COSIGN_PUBLIC_KEY_PEM),
  Buffer.from(bundle.signatureBase64 || '', 'base64'),
);
if (
  bundle.fixtureVersion !== 1
  || bundle.artifactSha256 !== digest
  || bundle.certificateIdentity !== option('--certificate-identity')
  || bundle.oidcIssuer !== option('--certificate-oidc-issuer')
  || !cryptographicallyValid
) {
  console.error('offline fixture signature rejected');
  process.exit(1);
}
`);
after(() => rmSync(verifierFixtureRoot, { recursive: true, force: true }));

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeSignature(artifactPath, signaturePath, overrides = {}) {
  const payload = {
    artifactSha256: digest(artifactPath),
    certificateIdentity,
    oidcIssuer,
    ...overrides,
  };
  writeFileSync(signaturePath, JSON.stringify({
    fixtureVersion: 1,
    ...payload,
    signatureBase64: sign(null, Buffer.from(JSON.stringify(payload)), fixturePrivateKey).toString('base64'),
  }));
}

function signedArgs(statePath, overrides = {}) {
  const indexPath = statePath + '.index.json';
  const bundleSignaturePath = statePath + '.sigstore.json';
  const indexSignaturePath = statePath + '.index.sigstore.json';
  if (existsSync(indexPath)) rmSync(indexPath);
  writeReleaseIndex(statePath, indexPath, {
    certificateIdentity: overrides.indexIdentity ?? certificateIdentity,
    oidcIssuer: overrides.indexIssuer ?? oidcIssuer,
  });
  writeSignature(statePath, bundleSignaturePath, overrides.bundleSignature);
  writeSignature(indexPath, indexSignaturePath, overrides.indexSignature);
  return [
    '--index-file', indexPath,
    '--bundle-signature-bundle', bundleSignaturePath,
    '--index-signature-bundle', indexSignaturePath,
    '--expected-certificate-identity', overrides.expectedIdentity ?? certificateIdentity,
    '--expected-oidc-issuer', overrides.expectedIssuer ?? oidcIssuer,
  ];
}

function seedProviderObject(providerRoot, key, input, retention = 'active') {
  const path = join(providerRoot, ...key.split('/'));
  const bytes = readFileSync(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  writeFileSync(path + '.metadata.json', JSON.stringify({
    VersionId: `seed-${digest(input).slice(0, 16)}`,
    ETag: `"${digest(input)}"`,
    LastModified: new Date().toISOString(),
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(Date.now() + 35 * 86_400_000).toISOString(),
    TagSet: [{ Key: 'lunchlineup-release-retention', Value: retention }],
  }));
}

function seedProviderRelease(providerRoot, statePath, { current = false, retention = 'active' } = {}) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const args = signedArgs(statePath);
  const indexPath = args[args.indexOf('--index-file') + 1];
  const bundleSignaturePath = args[args.indexOf('--bundle-signature-bundle') + 1];
  const indexSignaturePath = args[args.indexOf('--index-signature-bundle') + 1];
  seedProviderObject(providerRoot, `release-registry/releases/${state.sourceSha}.json`, statePath, retention);
  seedProviderObject(providerRoot, `release-registry/releases/${state.sourceSha}.sigstore.json`, bundleSignaturePath, retention);
  seedProviderObject(providerRoot, `release-registry/indexes/${state.sourceSha}.json`, indexPath, retention);
  seedProviderObject(providerRoot, `release-registry/indexes/${state.sourceSha}.sigstore.json`, indexSignaturePath, retention);
  if (current) {
    seedProviderObject(providerRoot, 'release-registry/index.json', indexPath, 'active');
    seedProviderObject(providerRoot, 'release-registry/index.sigstore.json', indexSignaturePath, 'active');
  }
  return { indexPath, indexSignaturePath };
}

const verifierEnv = {
  COSIGN_BINARY: process.execPath,
  COSIGN_ARGUMENT_PREFIX_JSON: JSON.stringify([fakeCosignPath]),
  TEST_COSIGN_PUBLIC_KEY_PEM: fixturePublicKeyPem,
};
function run(args, env = {}) {
  const effectiveArgs = [...args];
  const command = effectiveArgs[0];
  if ((command === 'publish' || command === 'bootstrap-retained') && !effectiveArgs.includes('--index-file')) {
    const statePath = effectiveArgs[effectiveArgs.indexOf('--state-file') + 1];
    effectiveArgs.push(...signedArgs(statePath));
  }
  if ((command === 'resolve' || command === 'repoint') && !effectiveArgs.includes('--expected-certificate-identity')) {
    effectiveArgs.push(
      '--expected-certificate-identity', certificateIdentity,
      '--expected-oidc-issuer', oidcIssuer,
    );
  }
  return spawnSync(process.execPath, ['scripts/release-bundle-registry.mjs', ...effectiveArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ALLOW_LOCAL_RELEASE_REGISTRY: 'true', ...verifierEnv, ...env },
  });
}

function fakeAwsEnvironment(scratch, mode = 'ok', existingProviderRoot = '') {
  const providerRoot = existingProviderRoot || join(scratch, `provider-${mode}`);
  const providerScript = join(scratch, `fake-aws-${mode}.mjs`);
  const providerLog = join(scratch, `fake-aws-${mode}.log`);
  mkdirSync(providerRoot, { recursive: true });
  writeFileSync(providerScript, `
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_AWS_MODE;
const root = process.env.FAKE_AWS_ROOT;
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const option = (name) => args[args.indexOf(name) + 1];
const objectPath = (key) => join(root, ...key.split('/'));
const metadataPath = (key) => objectPath(key) + '.metadata.json';
const output = (value) => process.stdout.write(JSON.stringify(value));
const command = args[0] + ' ' + args[1];

if (command === 's3api get-bucket-versioning') {
  output(mode === 'missing-versioning' ? {} : { Status: 'Enabled' });
} else if (command === 's3api get-object-lock-configuration') {
  output({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 35 } } } });
} else if (command === 's3api get-bucket-lifecycle-configuration') {
  if (mode === 'missing-lifecycle') output({});
  else if (mode === 'active-expiring-lifecycle') output({ Rules: [{ ID: 'unsafe-active-expiry', Status: 'Enabled', Filter: { Prefix: 'release-registry' }, Expiration: { Days: 35 }, NoncurrentVersionExpiration: { NoncurrentDays: 35 } }] });
  else output({ Rules: [
    {
      ID: 'obsolete-release-retention',
      Status: 'Enabled',
      Filter: { And: { Prefix: 'release-registry', Tags: [{ Key: 'lunchlineup-release-retention', Value: 'obsolete' }] } },
      Expiration: { Days: mode === 'premature-lifecycle' ? 1 : (mode === 'excessive-lifecycle' ? 120 : 35) },
    },
    {
      ID: 'release-registry-noncurrent-retention',
      Status: 'Enabled',
      Filter: { Prefix: 'release-registry' },
      NoncurrentVersionExpiration: { NoncurrentDays: 35 },
    },
  ] });
} else if (command === 's3api get-bucket-policy') {
  const actions = mode === 'delete-object-only'
    ? ['s3:DeleteObject']
    : (mode === 'delete-version-only' ? ['s3:DeleteObjectVersion'] : ['s3:DeleteObject', 's3:DeleteObjectVersion']);
  const statement = {
    Effect: 'Deny',
    Principal: mode === 'principal-scoped-deny' ? { AWS: 'arn:aws:iam::123456789012:role/release-writer' } : '*',
    Action: actions,
    Resource: mode === 'wrong-prefix-deny'
      ? 'arn:aws:s3:::fake-bucket/release-registry-sibling/*'
      : 'arn:aws:s3:::fake-bucket/release-registry/*',
  };
  if (mode === 'conditional-deletion-deny') statement.Condition = { Bool: { 'aws:SecureTransport': 'false' } };
  if (mode === 'protection-drift-after-repoint' && existsSync(join(root, '.protection-drift'))) {
    statement.Resource = 'arn:aws:s3:::fake-bucket/release-registry-sibling/*';
  }
  output({ Policy: JSON.stringify({ Version: '2012-10-17', Statement: [statement] }) });
} else if (command === 's3api head-object') {
  const key = option('--key');
  const path = objectPath(key);
  if (!existsSync(path)) process.exit(254);
  const stored = existsSync(metadataPath(key)) ? JSON.parse(readFileSync(metadataPath(key), 'utf8')) : {};
  const bytes = readFileSync(path);
  const lastModified = stored.LastModified ?? new Date().toISOString();
  const retainUntil = mode === 'premature-object-metadata'
    ? new Date(Date.parse(lastModified) + 86_400_000).toISOString()
    : stored.ObjectLockRetainUntilDate;
  output({
    VersionId: mode === 'missing-object-metadata' ? undefined : (stored.VersionId ?? 'mutable-version'),
    ETag: stored.ETag ?? '"' + createHash('sha256').update(bytes).digest('hex') + '"',
    ContentLength: mode === 'mismatched-object-bytes' ? bytes.byteLength + 1 : bytes.byteLength,
    ChecksumSHA256: mode === 'mismatched-object-digest' ? Buffer.alloc(32, 1).toString('base64') : createHash('sha256').update(bytes).digest('base64'),
    LastModified: lastModified,
    ObjectLockMode: stored.ObjectLockMode,
    ObjectLockRetainUntilDate: retainUntil,
  });
} else if (command === 's3api put-object') {
  const key = option('--key');
  const path = objectPath(key);
  if (
    mode === 'competing-pointer-before-put'
    && key === 'release-registry/index.json'
    && !existsSync(join(root, '.competing-pointer-written'))
  ) {
    const competingIndex = process.env.FAKE_AWS_COMPETING_INDEX;
    const competingSignature = process.env.FAKE_AWS_COMPETING_SIGNATURE;
    const installCompeting = (source, destinationKey) => {
      const destination = objectPath(destinationKey);
      const bytes = readFileSync(source);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      writeFileSync(metadataPath(destinationKey), JSON.stringify({
        VersionId: 'competing-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16),
        ETag: '"' + createHash('sha256').update(bytes).digest('hex') + '"',
        LastModified: new Date().toISOString(),
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(Date.now() + 35 * 86400000).toISOString(),
        TagSet: [{ Key: 'lunchlineup-release-retention', Value: 'active' }],
      }));
    };
    installCompeting(competingSignature, 'release-registry/index.sigstore.json');
    installCompeting(competingIndex, 'release-registry/index.json');
    writeFileSync(join(root, '.competing-pointer-written'), 'written');
    process.stderr.write('PreconditionFailed 412\\n');
    process.exit(1);
  }
  const current = existsSync(metadataPath(key)) ? JSON.parse(readFileSync(metadataPath(key), 'utf8')) : {};
  const ifNoneMatch = args.includes('--if-none-match');
  const ifMatch = args.includes('--if-match') ? option('--if-match') : null;
  if ((ifNoneMatch && existsSync(path)) || (ifMatch !== null && (!existsSync(path) || current.ETag !== ifMatch))) {
    process.stderr.write('PreconditionFailed 412\\n');
    process.exit(1);
  }
  if (mode === 'pre-pointer-failure' && key === 'release-registry/index.json' && !existsSync(join(root, '.pre-pointer-failed'))) {
    writeFileSync(join(root, '.pre-pointer-failed'), 'failed');
    process.exit(70);
  }
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(option('--body'), path);
  const bytes = readFileSync(path);
  const tagging = args.includes('--tagging') ? option('--tagging') : '';
  const [tagKey, tagValue] = tagging.split('=', 2);
  writeFileSync(metadataPath(key), JSON.stringify({
    VersionId: 'provider-version-' + createHash('sha256').update(key + Date.now()).digest('hex').slice(0, 16),
    ETag: '"' + createHash('sha256').update(bytes).digest('hex') + '"',
    LastModified: new Date().toISOString(),
    ObjectLockMode: option('--object-lock-mode'),
    ObjectLockRetainUntilDate: option('--object-lock-retain-until-date'),
    TagSet: tagKey ? [{ Key: tagKey, Value: tagValue }] : [],
  }));
  if (mode === 'protection-drift-after-repoint' && key === 'release-registry/index.json') {
    writeFileSync(join(root, '.protection-drift'), 'drifted');
  }
  output({ VersionId: 'created-version' });
} else if (command === 's3api get-object-tagging') {
  const stored = JSON.parse(readFileSync(metadataPath(option('--key')), 'utf8'));
  output({ TagSet: stored.TagSet ?? [] });
} else if (command === 's3api put-object-tagging') {
  const key = option('--key');
  const stored = JSON.parse(readFileSync(metadataPath(key), 'utf8'));
  stored.TagSet = JSON.parse(option('--tagging')).TagSet;
  writeFileSync(metadataPath(key), JSON.stringify(stored));
  output({});
} else if (command === 's3api put-object-retention') {
  const key = option('--key');
  const stored = JSON.parse(readFileSync(metadataPath(key), 'utf8'));
  const retention = JSON.parse(option('--retention'));
  stored.ObjectLockMode = retention.Mode;
  stored.ObjectLockRetainUntilDate = retention.RetainUntilDate;
  writeFileSync(metadataPath(key), JSON.stringify(stored));
  output({});
} else if (command === 's3 cp') {
  const source = args[2];
  const destination = args[3];
  const remoteKey = (uri) => new URL(uri).pathname.replace(/^\\/+/, '');
  if (source.startsWith('s3://')) {
    copyFileSync(objectPath(remoteKey(source)), destination);
  } else {
    const path = objectPath(remoteKey(destination));
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
  }
} else {
  process.stderr.write('unsupported fake aws command: ' + args.join(' ') + '\\n');
  process.exit(2);
}
`);
  return {
    providerRoot,
    providerLog,
    env: {
      RELEASE_REGISTRY_AWS_BINARY: process.execPath,
      RELEASE_REGISTRY_AWS_ARGUMENT_PREFIX_JSON: JSON.stringify([providerScript]),
      NODE_ENV: 'test',
      ALLOW_DIRECT_PROVIDER_COMMANDS_FOR_TESTS: 'true',
      FAKE_AWS_MODE: mode,
      FAKE_AWS_ROOT: providerRoot,
      FAKE_AWS_LOG: providerLog,
      RELEASE_REGISTRY_IMMUTABLE_RETENTION_DAYS: '35',
      RELEASE_REGISTRY_LIFECYCLE_MAX_RETENTION_DAYS: '90',
    },
  };
}

test('exact publication retries repair missing or corrupt mutable indexes without replacing immutable bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-'));
  try {
    const registry = join(scratch, 'registry');
    const statePath = join(scratch, 'state.json');
    const resolved = join(scratch, 'resolved.json');
    writeFileSync(statePath, JSON.stringify({ version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } }));
    const uri = pathToFileURL(registry).href;

    const publish = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(publish.status, 0, `${publish.stdout}\n${publish.stderr}`);
    const indexPath = join(registry, 'index.json');
    const immutablePath = join(registry, 'releases', `${sha}.json`);
    const immutableBytes = readFileSync(immutablePath);
    const publishedIndex = JSON.parse(readFileSync(indexPath));
    assert.equal(publishedIndex.currentSuccessfulSha, sha);
    assert.equal(publishedIndex.authenticity.certificateIdentity, certificateIdentity);
    assert.equal(publishedIndex.authenticity.oidcIssuer, oidcIssuer);
    assert.equal(publishedIndex.authenticity.bundle.sha256, digest(statePath));
    assert.equal(JSON.parse(immutableBytes).sourceSha, sha);

    rmSync(indexPath);
    const missingIndexRetry = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(missingIndexRetry.status, 0, `exact retry should restore a missing mutable index: ${missingIndexRetry.stderr}`);
    assert.equal(JSON.parse(readFileSync(indexPath)).currentSuccessfulSha, sha);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);

    writeFileSync(indexPath, '{corrupt mutable index');
    const corruptIndexRetry = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(corruptIndexRetry.status, 0, `exact retry should replace a corrupt mutable index: ${corruptIndexRetry.stderr}`);
    assert.equal(JSON.parse(readFileSync(indexPath)).currentSuccessfulSha, sha);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);

    const resolveResult = run(['resolve', '--registry-uri', uri, '--output', resolved]);
    assert.equal(resolveResult.status, 0, `${resolveResult.stdout}\n${resolveResult.stderr}`);
    assert.equal(JSON.parse(readFileSync(resolved)).sourceSha, sha);

    const newerSha = 'b'.repeat(40);
    const newerStatePath = join(scratch, 'newer-state.json');
    const newerState = {
      version: 2,
      sourceSha: newerSha,
      releaseManifest: { sourceSha: newerSha },
      runtimeSecret: {
        version: 1,
        provider: 'aws-secretsmanager',
        reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup',
        secretVersion: 'c'.repeat(32),
        sha256: 'd'.repeat(64),
      },
    };
    writeFileSync(newerStatePath, JSON.stringify(newerState));
    const newerPublish = run(['publish', '--registry-uri', uri, '--state-file', newerStatePath]);
    assert.equal(newerPublish.status, 0);
    const explicitOld = join(scratch, 'explicit-old.json');
    const targetedResolve = run([
      'resolve', '--registry-uri', uri, '--source-sha', sha, '--output', explicitOld,
    ]);
    assert.equal(targetedResolve.status, 0);
    assert.equal(JSON.parse(readFileSync(explicitOld)).sourceSha, sha);
    assert.match(targetedResolve.stdout, /selection=explicit/);
    const currentResolve = join(scratch, 'current.json');
    assert.equal(run(['resolve', '--registry-uri', uri, '--output', currentResolve]).status, 0);
    assert.equal(JSON.parse(readFileSync(currentResolve)).sourceSha, newerSha);

    const repoint = run([
      'repoint', '--registry-uri', uri, '--source-sha', sha,
      '--expected-current-source-sha', newerSha,
      '--confirm', `repoint-current-to:${sha}`,
    ]);
    assert.equal(repoint.status, 0, `${repoint.stdout}\n${repoint.stderr}`);
    assert.match(repoint.stdout, /release_registry_current_repointed/);
    const repointed = join(scratch, 'repointed.json');
    assert.equal(run(['resolve', '--registry-uri', uri, '--output', repointed]).status, 0);
    assert.equal(JSON.parse(readFileSync(repointed)).sourceSha, sha);
    assert.notEqual(run([
      'repoint', '--registry-uri', uri, '--source-sha', newerSha,
      '--expected-current-source-sha', sha, '--confirm', 'wrong',
    ]).status, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('publication rejects a same-SHA immutable object with different bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-conflict-'));
  try {
    const registry = join(scratch, 'registry');
    const statePath = join(scratch, 'state.json');
    const conflictingStatePath = join(scratch, 'conflicting-state.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(conflictingStatePath, `${JSON.stringify(state)}\n`);
    const uri = pathToFileURL(registry).href;

    const publish = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(publish.status, 0, `${publish.stdout}\n${publish.stderr}`);
    const immutablePath = join(registry, 'releases', `${sha}.json`);
    const immutableBytes = readFileSync(immutablePath);
    const indexBytes = readFileSync(join(registry, 'index.json'));

    const conflict = run(['publish', '--registry-uri', uri, '--state-file', conflictingStatePath]);
    assert.notEqual(conflict.status, 0, 'same source SHA must not make different immutable bytes idempotent');
    assert.match(conflict.stderr, /Existing immutable release bundle object does not match this publication/);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);
    assert.deepEqual(readFileSync(join(registry, 'index.json')), indexBytes);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 publication enforces versioning, Object Lock, deletion denial, bounded lifecycle, and exact immutable provider readback', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-provider-policy-'));
  const statePath = join(scratch, 'state.json');
  const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
  writeFileSync(statePath, JSON.stringify(state));
  try {
    const successProvider = fakeAwsEnvironment(scratch, 'ok');
    const published = run([
      'publish', '--registry-uri', 's3://fake-bucket/release-registry', '--state-file', statePath,
    ], successProvider.env);
    assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`);
    const calls = readFileSync(successProvider.providerLog, 'utf8');
    assert.match(calls, /get-bucket-versioning/);
    assert.match(calls, /get-object-lock-configuration/);
    assert.match(calls, /get-bucket-lifecycle-configuration/);
    assert.match(calls, /get-bucket-policy/);
    assert.match(calls, /--if-none-match/);
    assert.match(calls, /--checksum-sha256/);
    assert.match(calls, /--object-lock-mode/);
    assert.match(calls, /--object-lock-retain-until-date/);
    assert.match(calls, /--checksum-mode/);
    assert.match(published.stdout, /release_bundle_published/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 registry protection rejects unsafe lifecycle, deletion, and immutable readback metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-provider-rejections-'));
  const statePath = join(scratch, 'state.json');
  const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
  writeFileSync(statePath, JSON.stringify(state));
  try {
    for (const [mode, expected] of [
      ['missing-versioning', /versioning must be Enabled/],
      ['missing-lifecycle', /lifecycle metadata is missing/],
      ['active-expiring-lifecycle', /can expire active recovery objects/],
      ['premature-lifecycle', /expires current objects before the immutable retention minimum/],
      ['excessive-lifecycle', /retains current objects beyond the configured lifecycle maximum/],
      ['delete-object-only', /unconditionally deny object and version deletion/],
      ['delete-version-only', /unconditionally deny object and version deletion/],
      ['conditional-deletion-deny', /unconditionally deny object and version deletion/],
      ['principal-scoped-deny', /unconditionally deny object and version deletion/],
      ['wrong-prefix-deny', /unconditionally deny object and version deletion/],
      ['missing-object-metadata', /missing an exact version ID/],
      ['mismatched-object-bytes', /byte count does not match publication/],
      ['mismatched-object-digest', /digest does not match publication/],
      ['premature-object-metadata', /retention metadata is premature/],
    ]) {
      const provider = fakeAwsEnvironment(scratch, mode);
      const result = run([
        'publish', '--registry-uri', 's3://fake-bucket/release-registry', '--state-file', statePath,
      ], provider.env);
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, expected, mode);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 conditional pointer publication repairs pre-pointer and authenticated split-pair state idempotently', { timeout: 120_000 }, () => {
  if (process.platform === 'win32') {
    const script = readFileSync(join(root, 'scripts/release-bundle-registry.mjs'), 'utf8');
    assert.match(script, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
    assert.match(script, /'--if-none-match', '\*'/);
    assert.match(script, /'--if-match', expectedEtag/);
    assert.match(script, /indexes\/\$\{sourceSha\}\.sigstore\.json/);
    assert.match(script, /authenticated split-pair repair/);
    assert.match(script, /current\.sourceSha === expectedSha/);
    assert.match(script, /changed to a competing release; refusing mutation/);
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-pointer-repair-'));
  try {
    const provider = fakeAwsEnvironment(scratch, 'pre-pointer-failure');
    const oldStatePath = join(scratch, 'old.json');
    const targetStatePath = join(scratch, 'target.json');
    const targetSha = 'b'.repeat(40);
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(oldStatePath, JSON.stringify(state));
    writeFileSync(targetStatePath, JSON.stringify({ ...state, sourceSha: targetSha, releaseManifest: { sourceSha: targetSha } }));
    seedProviderRelease(provider.providerRoot, oldStatePath, { current: true });
    seedProviderRelease(provider.providerRoot, targetStatePath);
    const uri = 's3://fake-bucket/release-registry';

    const repoint = run([
      'repoint', '--registry-uri', uri, '--source-sha', targetSha,
      '--expected-current-source-sha', sha, '--confirm', `repoint-current-to:${targetSha}`,
    ], provider.env);
    assert.equal(repoint.status, 0, `${repoint.stdout}\n${repoint.stderr}`);
    assert.match(repoint.stdout, /release_registry_pointer_reconciled/);
    assert.equal(existsSync(join(provider.providerRoot, '.pre-pointer-failed')), true);
    assert.equal(JSON.parse(readFileSync(join(provider.providerRoot, 'release-registry/index.json'))).currentSuccessfulSha, targetSha);
    const providerCalls = readFileSync(provider.providerLog, 'utf8');
    assert.match(providerCalls, /--if-match/);
    assert.ok((providerCalls.match(/index\.sigstore\.json/g) ?? []).length >= 4, 'pre-pointer failure must authenticate and repair its split signature before retry');
    const oldMetadata = JSON.parse(readFileSync(join(provider.providerRoot, `release-registry/releases/${sha}.json.metadata.json`)));
    const targetMetadata = JSON.parse(readFileSync(join(provider.providerRoot, `release-registry/releases/${targetSha}.json.metadata.json`)));
    assert.deepEqual(oldMetadata.TagSet, [{ Key: 'lunchlineup-release-retention', Value: 'obsolete' }]);
    assert.deepEqual(targetMetadata.TagSet, [{ Key: 'lunchlineup-release-retention', Value: 'active' }]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 authenticated split-pair repair accepts an already-target pointer idempotently', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-pointer-idempotent-'));
  try {
    const provider = fakeAwsEnvironment(scratch, 'ok');
    const oldStatePath = join(scratch, 'old.json');
    const targetStatePath = join(scratch, 'target.json');
    const targetSha = 'b'.repeat(40);
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(oldStatePath, JSON.stringify(state));
    writeFileSync(targetStatePath, JSON.stringify({ ...state, sourceSha: targetSha, releaseManifest: { sourceSha: targetSha } }));
    const oldMaterial = seedProviderRelease(provider.providerRoot, oldStatePath, { retention: 'obsolete' });
    const targetMaterial = seedProviderRelease(provider.providerRoot, targetStatePath, { current: true });
    seedProviderObject(provider.providerRoot, 'release-registry/index.sigstore.json', oldMaterial.indexSignaturePath, 'active');

    const result = run([
      'repoint', '--registry-uri', 's3://fake-bucket/release-registry', '--source-sha', targetSha,
      '--expected-current-source-sha', targetSha, '--confirm', `repoint-current-to:${targetSha}`,
    ], provider.env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(
      readFileSync(join(provider.providerRoot, 'release-registry/index.sigstore.json')),
      readFileSync(targetMaterial.indexSignaturePath),
    );
    assert.equal(JSON.parse(readFileSync(join(provider.providerRoot, 'release-registry/index.json'))).currentSuccessfulSha, targetSha);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 conditional repoint rejects a newer authenticated competing pointer', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-pointer-race-'));
  try {
    const provider = fakeAwsEnvironment(scratch, 'competing-pointer-before-put');
    const oldStatePath = join(scratch, 'old.json');
    const targetStatePath = join(scratch, 'target.json');
    const competingStatePath = join(scratch, 'competing.json');
    const targetSha = 'b'.repeat(40);
    const competingSha = 'c'.repeat(40);
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(oldStatePath, JSON.stringify(state));
    writeFileSync(targetStatePath, JSON.stringify({ ...state, sourceSha: targetSha, releaseManifest: { sourceSha: targetSha } }));
    writeFileSync(competingStatePath, JSON.stringify({ ...state, sourceSha: competingSha, releaseManifest: { sourceSha: competingSha } }));
    seedProviderRelease(provider.providerRoot, oldStatePath, { current: true });
    seedProviderRelease(provider.providerRoot, targetStatePath, { retention: 'obsolete' });
    const competing = seedProviderRelease(provider.providerRoot, competingStatePath);
    const result = run([
      'repoint', '--registry-uri', 's3://fake-bucket/release-registry', '--source-sha', targetSha,
      '--expected-current-source-sha', sha, '--confirm', `repoint-current-to:${targetSha}`,
    ], {
      ...provider.env,
      FAKE_AWS_COMPETING_INDEX: competing.indexPath,
      FAKE_AWS_COMPETING_SIGNATURE: competing.indexSignaturePath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /competing release/);
    assert.equal(
      JSON.parse(readFileSync(join(provider.providerRoot, 'release-registry/index.json'))).currentSuccessfulSha,
      competingSha,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('S3 repoint fails authenticated post-readback when protection drifts after pointer mutation', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-repoint-drift-'));
  try {
    const provider = fakeAwsEnvironment(scratch, 'ok');
    const statePath = join(scratch, 'old.json');
    const newerStatePath = join(scratch, 'new.json');
    const oldState = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    const newerSha = 'b'.repeat(40);
    writeFileSync(statePath, JSON.stringify(oldState));
    writeFileSync(newerStatePath, JSON.stringify({ ...oldState, sourceSha: newerSha, releaseManifest: { sourceSha: newerSha } }));
    const uri = 's3://fake-bucket/release-registry';
    seedProviderRelease(provider.providerRoot, statePath, { retention: 'obsolete' });
    seedProviderRelease(provider.providerRoot, newerStatePath, { current: true });

    const driftProvider = fakeAwsEnvironment(scratch, 'protection-drift-after-repoint', provider.providerRoot);
    const result = run([
      'repoint', '--registry-uri', uri, '--source-sha', sha,
      '--expected-current-source-sha', newerSha,
      '--confirm', `repoint-current-to:${sha}`,
    ], driftProvider.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unconditionally deny object and version deletion/);
    assert.equal(existsSync(join(provider.providerRoot, '.protection-drift')), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('registry resolution fails closed on tamper, wrong signer policy, and a missing verifier', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-auth-fail-'));
  try {
    const registryPath = join(scratch, 'registry');
    const registry = pathToFileURL(registryPath).href;
    const statePath = join(scratch, 'state.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(statePath, JSON.stringify(state));
    assert.equal(run(['publish', '--registry-uri', registry, '--state-file', statePath]).status, 0);

    const wrongIdentity = run([
      'resolve', '--registry-uri', registry, '--output', join(scratch, 'wrong-identity.json'),
      '--expected-certificate-identity', 'https://github.com/tuckerplee/other/.github/workflows/ci.yml@refs/heads/main',
      '--expected-oidc-issuer', oidcIssuer,
    ]);
    assert.notEqual(wrongIdentity.status, 0);
    const wrongIssuer = run([
      'resolve', '--registry-uri', registry, '--output', join(scratch, 'wrong-issuer.json'),
      '--expected-certificate-identity', certificateIdentity,
      '--expected-oidc-issuer', 'https://issuer.example.com',
    ]);
    assert.notEqual(wrongIssuer.status, 0);

    const invalidTargetOutput = join(scratch, 'invalid-target.json');
    const invalidTarget = run([
      'resolve', '--registry-uri', registry, '--source-sha', 'NOT-A-SHA', '--output', invalidTargetOutput,
    ]);
    assert.notEqual(invalidTarget.status, 0);
    assert.match(invalidTarget.stderr, /exactly 40 lowercase hexadecimal/);
    assert.equal(existsSync(invalidTargetOutput), false);

    const missingVerifier = run(
      ['resolve', '--registry-uri', registry, '--output', join(scratch, 'missing-verifier.json')],
      { COSIGN_BINARY: join(scratch, 'missing-cosign'), COSIGN_ARGUMENT_PREFIX_JSON: '' },
    );
    assert.notEqual(missingVerifier.status, 0);
    assert.match(missingVerifier.stderr, /Cosign verifier is required/);

    writeFileSync(join(registryPath, 'releases', sha + '.json'), JSON.stringify({ ...state, tampered: true }));
    const tampered = run(['resolve', '--registry-uri', registry, '--output', join(scratch, 'tampered.json')]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /Cosign rejected release authenticity|bundle sha256/);
    assert.equal(existsSync(join(scratch, 'tampered.json')), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('publication rejects validly signed metadata with wrong source SHA or bundle digest', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-auth-metadata-'));
  try {
    const registry = pathToFileURL(join(scratch, 'registry')).href;
    const statePath = join(scratch, 'state.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(statePath, JSON.stringify(state));

    const sourceArgs = signedArgs(statePath);
    const indexPath = sourceArgs[sourceArgs.indexOf('--index-file') + 1];
    const indexSignaturePath = sourceArgs[sourceArgs.indexOf('--index-signature-bundle') + 1];
    const wrongSource = JSON.parse(readFileSync(indexPath, 'utf8'));
    wrongSource.currentSuccessfulSha = 'b'.repeat(40);
    writeFileSync(indexPath, JSON.stringify(wrongSource));
    writeSignature(indexPath, indexSignaturePath);
    const sourceResult = run(['publish', '--registry-uri', registry, '--state-file', statePath, ...sourceArgs]);
    assert.notEqual(sourceResult.status, 0);
    assert.match(sourceResult.stderr, /source SHA/);

    const digestArgs = signedArgs(statePath);
    const digestIndexPath = digestArgs[digestArgs.indexOf('--index-file') + 1];
    const digestSignaturePath = digestArgs[digestArgs.indexOf('--index-signature-bundle') + 1];
    const wrongDigest = JSON.parse(readFileSync(digestIndexPath, 'utf8'));
    wrongDigest.authenticity.bundle.sha256 = 'c'.repeat(64);
    writeFileSync(digestIndexPath, JSON.stringify(wrongDigest));
    writeSignature(digestIndexPath, digestSignaturePath);
    const digestResult = run(['publish', '--registry-uri', registry, '--state-file', statePath, ...digestArgs]);
    assert.notEqual(digestResult.status, 0);
    assert.match(digestResult.stderr, /bundle sha256/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('first registry bootstrap imports a retained current-live bundle only after exact live identity proof', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-bootstrap-'));
  try {
    const registry = join(scratch, 'registry');
    const retainedPath = join(scratch, 'independently-retained.json');
    const preparedPath = join(scratch, 'verified-retained.json');
    const apiProof = join(scratch, 'api-proof.json');
    const webProof = join(scratch, 'web-proof.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    const proof = (healthUrl, surface) => ({ status: 'passed', sourceSha: sha, servedReleaseSha: sha, releaseIdentityHeader: 'X-LunchLineup-Release', healthUrl, surface, httpStatus: 200, responseSha256: 'c'.repeat(64), responseBytes: 2048, checkedAt: new Date().toISOString() });
    writeFileSync(retainedPath, JSON.stringify(state));
    writeFileSync(apiProof, JSON.stringify(proof('https://lunchlineup.example/api/health', 'health')));
    writeFileSync(webProof, JSON.stringify(proof('https://lunchlineup.example/', 'public-html')));
    const uri = pathToFileURL(registry).href;
    const bootstrapOptions = (command, registryUri, output, confirmation = 'bootstrap-current-live-release:' + sha) => [
      command, '--registry-uri', registryUri,
      '--state-file', output,
      '--verified-source-sha', sha,
      '--confirm', confirmation,
      '--max-live-proof-age-seconds', '300',
      '--expected-api-health-url', 'https://lunchlineup.example/api/health',
      '--expected-public-web-url', 'https://lunchlineup.example/',
      '--live-identity-proof', apiProof,
      '--live-identity-proof', webProof,
    ];
    const wrongPrepare = bootstrapOptions('prepare-bootstrap-retained', uri, join(scratch, 'wrong-confirmation.json'), 'wrong');
    wrongPrepare.push('--retained-bundle-uri', pathToFileURL(retainedPath).href);
    assert.notEqual(run(wrongPrepare).status, 0);

    const prepare = bootstrapOptions('prepare-bootstrap-retained', uri, preparedPath);
    prepare.push('--retained-bundle-uri', pathToFileURL(retainedPath).href);
    assert.equal(run(prepare).status, 0);
    mkdirSync(join(registry, 'releases'), { recursive: true });
    writeFileSync(join(registry, 'releases', sha + '.json'), JSON.stringify(state));
    const result = run(bootstrapOptions('bootstrap-retained', uri, preparedPath));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(registry, 'index.json'))).currentSuccessfulSha, sha);
    assert.notEqual(run(bootstrapOptions('bootstrap-retained', uri, preparedPath)).status, 0);

    writeFileSync(webProof, JSON.stringify(proof('https://lunchlineup.example/', 'health')));
    const wrongSurfaceRegistry = pathToFileURL(join(scratch, 'wrong-surface-registry')).href;
    const wrongSurfaceArgs = bootstrapOptions('prepare-bootstrap-retained', wrongSurfaceRegistry, join(scratch, 'wrong-surface.json'));
    wrongSurfaceArgs.push('--retained-bundle-uri', pathToFileURL(retainedPath).href);
    const wrongSurface = run(wrongSurfaceArgs);
    assert.notEqual(wrongSurface.status, 0);
    assert.match(wrongSurface.stderr, /strict canonical-root public-HTML evidence/);

    const staleProof = proof('https://lunchlineup.example/other', 'public-html');
    staleProof.checkedAt = new Date(Date.now() - 301_000).toISOString();
    writeFileSync(webProof, JSON.stringify(staleProof));
    const emptyRegistry = pathToFileURL(join(scratch, 'empty-registry')).href;
    const staleArgs = bootstrapOptions('prepare-bootstrap-retained', emptyRegistry, join(scratch, 'stale-proof.json'));
    staleArgs.push('--retained-bundle-uri', pathToFileURL(retainedPath).href);
    assert.notEqual(run(staleArgs).status, 0, 'stale live proof must not establish a baseline');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('release registry external commands and retained HTTPS fetches are bounded', () => {
  const script = readFileSync(join(root, 'scripts/release-bundle-registry.mjs'), 'utf8');
  const owner = readFileSync(join(root, 'scripts/backup.sh'), 'utf8');
  assert.match(script, /RELEASE_REGISTRY_COMMAND_TIMEOUT_MS/);
  assert.match(script, /runBoundedProviderCommand/);
  assert.doesNotMatch(script, /spawnSync\(/);
  assert.match(owner, /kill -TERM/);
  assert.match(owner, /kill -KILL/);
  assert.match(owner, /reason="output-cap"/);
  assert.match(owner, /reason="download-cap"/);
  assert.match(script, /AbortController/);
  assert.match(script, /RELEASE_REGISTRY_FETCH_MAX_BYTES/);
  assert.match(script, /remote state is unknown and requires authenticated readback reconciliation/);
  assert.match(script, /release_registry_pointer_reconciled/);
});
test('release registry and materializer reject persisted runtime secret bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-secret-bytes-'));
  try {
    const registry = pathToFileURL(join(scratch, 'registry')).href;
    const statePath = join(scratch, 'state.json');
    writeFileSync(statePath, JSON.stringify({ version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) }, runtimeEnvBase64: Buffer.from('SECRET=value').toString('base64') }));
    assert.notEqual(run(['publish', '--registry-uri', registry, '--state-file', statePath]).status, 0);
    const materialize = spawnSync(process.execPath, ['scripts/materialize-rollback-state.mjs', '--state-file', statePath, ...signedArgs(statePath), '--output-dir', join(scratch, 'materialized')], { cwd: root, encoding: 'utf8', env: { ...process.env, ...verifierEnv } });
    assert.notEqual(materialize.status, 0);
    assert.match(materialize.stderr, /forbidden runtime secret material/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('CI bootstraps and retains one validated baseline before centralized rollback can arm', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const bootstrap = ci.indexOf('name: Bootstrap registry from verified current-live retained bundle');
  const firstResolve = ci.indexOf('name: Resolve and materialize previous successful release bundle', bootstrap);
  const candidateMutation = ci.indexOf('name: "17. Guarded production deploy;');
  assert.ok(bootstrap > 0 && firstResolve > bootstrap && candidateMutation > firstResolve);
  const automaticDeploy = ci.slice(
    ci.indexOf('  deploy-production:'),
    ci.indexOf('  production-image-inventory:'),
  );
  const emergencyRollback = ci.slice(
    ci.indexOf('  emergency-production-rollback:'),
    ci.indexOf('  validate-release-gates:'),
  );
  assert.equal((automaticDeploy.match(/release-bundle-registry\.mjs resolve/g) ?? []).length, 3);
  assert.equal((emergencyRollback.match(/release-bundle-registry\.mjs resolve/g) ?? []).length, 3);
  assert.match(emergencyRollback, /release-bundle-registry\.mjs repoint/);
  assert.equal((ci.match(/REGISTRY_BASELINE_AVAILABLE=true/g) ?? []).length, 1);
  assert.equal((ci.match(/name: Verify previous rollback release inputs/g) ?? []).length, 1);
  assert.match(ci, /Retain validated secret-free rollback baseline/);
  assert.match(
    automaticDeploy,
    /Materialize retained automatic rollback baseline[\s\S]*rollback_handoff="\$RUNNER_TEMP\/lunchlineup-rollback-handoff"[\s\S]*rollback_state="\$rollback_handoff\/release\.json"/,
  );
  assert.match(automaticDeploy, /Require completed automatic rollback after release failure/);
  assert.match(automaticDeploy, /steps\.arm_production_rollback\.outcome == 'success'/);
  assert.doesNotMatch(ci, /REGISTRY_BASELINE_AVAILABLE=false|bootstrap-first-production-release|release-bundle-registry\.mjs bootstrap --/);
  assert.match(ci, /bootstrap-current-live-release:\$BOOTSTRAP_LIVE_SOURCE_SHA/);
  assert.ok(ci.includes('node scripts/build-release-bundle.mjs'));
  assert.ok(ci.includes('--expected-source-sha "$GITHUB_SHA"'));
  assert.ok(ci.includes('cosign sign-blob --yes --bundle "$bundle_signature" "$release_bundle"'));
  assert.ok(ci.includes('node scripts/release-bundle-registry.mjs publish'));
  assert.ok(ci.includes('--bundle-signature-bundle "$bundle_signature"'));
});

test('old release compatibility proof requires isolated clone, exact SHAs, and passed smoke', () => {
  const proof = {
    version: 1,
    status: 'passed',
    previousReleaseSha: sha,
    candidateReleaseSha: 'b'.repeat(40),
    database: { isolatedClone: true, productionMutated: false },
    candidateSchema: { applied: true },
    oldReleaseSmoke: { status: 'passed' },
    completedAt: new Date().toISOString(),
    evidenceUri: 's3://proof/compatibility.json',
  };
  assert.doesNotThrow(() => verifyOldReleaseCompatibility(proof, { previousSha: sha, candidateSha: 'b'.repeat(40) }));
  assert.throws(() => verifyOldReleaseCompatibility({ ...proof, database: { isolatedClone: false, productionMutated: false } }, { previousSha: sha, candidateSha: 'b'.repeat(40) }), /isolated clone/);
});
test('bootstrap dispatch is isolated from push-only deployment', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const bootstrapStart = ci.indexOf('  bootstrap-release-registry:');
  const emergencyStart = ci.indexOf('  emergency-production-rollback:');
  const releaseGateStart = ci.indexOf('  validate-release-gates:');
  const deployStart = ci.indexOf('  deploy-production:');
  const bootstrapJob = ci.slice(bootstrapStart, emergencyStart);
  const deployJob = ci.slice(deployStart, ci.indexOf('  production-image-inventory:', deployStart));

  assert.ok(bootstrapStart > 0 && releaseGateStart > bootstrapStart);
  assert.match(bootstrapJob, /needs: manual-production-operation-policy/);
  assert.match(bootstrapJob, /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.bootstrap_release_registry == true && inputs\.emergency_production_rollback != true/);
  assert.match(bootstrapJob, /environment: production/);
  assert.match(bootstrapJob, /bootstrap-current-live-release:\$BOOTSTRAP_LIVE_SOURCE_SHA/);
  assert.match(ci, /validate-release-gates:[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /deploy-staging:[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(deployJob, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deployJob, /bootstrap-retained|bootstrap_release_registry/);
  const imagePushLines = ci.split('\n').filter((line) => line.includes('push: ${{ github.event_name'));
  assert.equal(imagePushLines.length, 8);
  for (const line of imagePushLines) {
    assert.match(line, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  }
});
