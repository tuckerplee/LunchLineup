import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { buildDeploymentContract } from './write-deployment-contract.mjs';

const requiredServices = ['api', 'web', 'engine', 'worker', 'migrate', 'control', 'backup'];
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
const digestSuffixPattern = /@sha256:[a-f0-9]{64}$/i;
const appComposeImagePattern =
  /^\$\{IMAGE_PREFIX:-lunchlineup\}\/(?:api|web|engine|worker|migrate|control|backup):\$\{IMAGE_TAG:-local\}$/;
const requiredLaunchProofEntries = ['runtimeEnv', 'dast', 'load', 'drDrill', 'pitrDrill', 'alertRoute'];
const placeholderProofPattern = /(change_me|replace_me|example|placeholder|todo|skipped|not_applicable|n\/a|dummy|fake)/i;
const forbiddenCommandPatterns = [
  { pattern: /(^|\s)--build(\s|$)/i, message: 'must not rebuild local source with --build' },
  { pattern: /\bdocker(?:\s+compose|-compose)\s+build\b/i, message: 'must not run docker compose build' },
  { pattern: /\bdocker\s+build(?:x\s+build)?\b/i, message: 'must not run docker build' },
  { pattern: /(^|[/:=])latest(\s|$|[@"'])/i, message: 'must not use latest tags' },
  { pattern: /(^|[/:=])local(\s|$|[@"'])/i, message: 'must not use local tags' },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(
    'Usage: node scripts/verify-release-artifacts.mjs <release-manifest.json> [--source-sha <sha>] [--launch-proof-file PATH] [--launch-proof-mode candidate|rollback] [--max-proof-age-seconds N] [--verification-time ISO] [--command-env NAME] [--post-deploy-proof-command-env NAME] [--rollback-command-env NAME] [--production-api-health-url-env NAME] [--deployment-root DIR] [--dockerfile-dir DIR] [--compose-file PATH] [--workflow-file PATH]',
  );
}

function parseArgs(argv) {
  const options = {
    manifestPath: undefined,
    sourceSha: process.env.GITHUB_SHA || undefined,
    commandEnvNames: [],
    postDeployProofCommandEnvNames: [],
    rollbackCommandEnvNames: [],
    productionApiHealthUrlEnvNames: [],
    launchProofFile: null,
    launchProofMode: 'candidate',
    maxProofAgeSeconds: process.env.LAUNCH_PROOF_MAX_AGE_SECONDS || '86400',
    verificationTime: process.env.LAUNCH_PROOF_VERIFICATION_TIME || new Date().toISOString(),
    deploymentRoot: process.cwd(),
    dockerfileDir: 'infrastructure/docker',
    composeFile: 'docker-compose.yml',
    workflowFile: '.github/workflows/ci.yml',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }

    if (arg === '--source-sha') {
      options.sourceSha = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--command-env') {
      options.commandEnvNames.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--post-deploy-proof-command-env') {
      options.postDeployProofCommandEnvNames.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--rollback-command-env') {
      options.rollbackCommandEnvNames.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--production-api-health-url-env') {
      options.productionApiHealthUrlEnvNames.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--launch-proof-file') {
      options.launchProofFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--launch-proof-mode') {
      options.launchProofMode = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--max-proof-age-seconds') {
      options.maxProofAgeSeconds = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--verification-time') {
      options.verificationTime = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--dockerfile-dir') {
      options.dockerfileDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--deployment-root') {
      options.deploymentRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--compose-file') {
      options.composeFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--workflow-file') {
      options.workflowFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unsupported option: ${arg}`);
    }

    if (options.manifestPath) {
      fail(`Unexpected argument: ${arg}`);
    }
    options.manifestPath = arg;
  }

  if (!options.manifestPath) {
    usage();
    process.exit(64);
  }

  for (const [label, value] of [
    ...options.commandEnvNames.map((name) => ['Command environment option', name]),
    ...options.postDeployProofCommandEnvNames.map((name) => ['Post-deploy proof command environment option', name]),
    ...options.rollbackCommandEnvNames.map((name) => ['Rollback command environment option', name]),
    ...options.productionApiHealthUrlEnvNames.map((name) => ['Production API health URL environment option', name]),
    ['Launch proof file option', options.launchProofFile],
    ['Deployment root option', options.deploymentRoot],
    ['Dockerfile directory option', options.dockerfileDir],
    ['Compose file option', options.composeFile],
    ['Workflow file option', options.workflowFile],
  ]) {
    if (label === 'Launch proof file option' && value === null) {
      continue;
    }

    if (!value) {
      fail(`${label} requires a value.`);
    }
  }

  options.maxProofAgeSeconds = Number(options.maxProofAgeSeconds);
  if (!Number.isInteger(options.maxProofAgeSeconds) || options.maxProofAgeSeconds <= 0) {
    fail('Maximum launch-proof age must be a positive integer number of seconds.');
  }
  if (!['candidate', 'rollback'].includes(options.launchProofMode)) {
    fail('Launch proof mode must be candidate or rollback.');
  }
  options.verificationTime = verifyTimestamp(options.verificationTime, 'Launch-proof verification time');
  options.deploymentRoot = resolve(options.deploymentRoot);

  for (const name of ['dockerfileDir', 'composeFile', 'workflowFile']) {
    if (!isAbsolute(options[name])) options[name] = join(options.deploymentRoot, options[name]);
  }

  return options;
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Unable to read release manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`Unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isReservedHostname(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'example.com' ||
    normalized === 'example.net' ||
    normalized === 'example.org' ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org') ||
    normalized === 'test' ||
    normalized.endsWith('.test') ||
    normalized === 'invalid' ||
    normalized.endsWith('.invalid')
    || normalized === 'local'
    || normalized.endsWith('.local')
  );
}

function isPrivateIp(host) {
  if (isIP(host) === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::' || normalized === '::1' || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
  }

  if (isIP(host) !== 4) {
    return false;
  }
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function verifyProductionHealthProof(config) {
  if (!isObject(config)) {
    fail('productionHealthProof is required in the release manifest.');
  }

  const domain = requireString(config.domain, 'productionHealthProof.domain').toLowerCase().replace(/\.$/, '');
  if (!isPublicProofHostname(domain) || isIP(domain)) {
    fail('productionHealthProof.domain must be a real public DNS hostname.');
  }

  const value = requireString(config.url, 'productionHealthProof.url');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('productionHealthProof.url must be a valid HTTPS URL.');
  }

  if (url.protocol !== 'https:' || !isPublicProofHostname(url.hostname)) {
    fail('productionHealthProof.url must use HTTPS and a real public hostname.');
  }
  if (url.hostname.toLowerCase().replace(/\.$/, '') !== domain) {
    fail('productionHealthProof.url must use the same hostname as productionHealthProof.domain.');
  }
  if (url.username || url.password || url.search || url.hash) {
    fail('productionHealthProof.url must not contain credentials, a query, or a fragment.');
  }
  if (!['/health', '/api/health'].includes(url.pathname)) {
    fail('productionHealthProof.url must target /health or /api/health.');
  }
  if (url.port && url.port !== '443') {
    fail('productionHealthProof.url must use the default HTTPS port.');
  }

  const runtimeEnvPath = process.env.PRODUCTION_RUNTIME_ENV_PATH || process.env.COMPOSE_SERVICE_ENV_FILE;
  if (runtimeEnvPath) {
    const { parsed } = parseEnvFile(runtimeEnvPath);
    if (String(parsed.DOMAIN ?? '').toLowerCase().replace(/\.$/, '') !== domain) {
      fail('productionHealthProof.domain must match DOMAIN in the validated production runtime env.');
    }
    if (String(parsed.PRODUCTION_API_HEALTH_URL ?? '') !== value) {
      fail('productionHealthProof.url must match PRODUCTION_API_HEALTH_URL in the validated production runtime env.');
    }
  }

  return { domain, url: value };
}

function verifyProductionHealthUrlEnvironment(config, environmentName) {
  const value = requireString(process.env[environmentName], environmentName);
  if (value !== config.url) {
    fail(`${environmentName} must exactly match productionHealthProof.url in the release manifest.`);
  }
}

function isPublicProofHostname(host) {
  return Boolean(host && host.includes('.') && !isReservedHostname(host) && !isPrivateIp(host));
}

function isVagueProofReference(value) {
  return /(^|[/:_-])(latest|current)([/:_.-]|$)/i.test(value);
}

function verifyHttpsProofUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a valid HTTPS URL.`);
  }

  if (url.protocol !== 'https:') {
    fail(`${label} must use https.`);
  }

  if (!isPublicProofHostname(url.hostname)) {
    fail(`${label} must use a real public hostname.`);
  }

  if (isVagueProofReference(value)) {
    fail(`${label} must reference a specific retained proof, not latest/current.`);
  }

  return url;
}

function verifyProofUri(value, label, { requireJson = false } = {}) {
  const uri = requireString(value, label);

  if (placeholderProofPattern.test(uri)) {
    fail(`${label} must not contain placeholder or skipped proof text.`);
  }

  if (isVagueProofReference(uri)) {
    fail(`${label} must reference a specific retained proof, not latest/current.`);
  }

  if (requireJson && !/\.json(?:[?#].*)?$/i.test(uri)) {
    fail(`${label} must reference a retained JSON proof file.`);
  }

  if (/^https:\/\//i.test(uri)) {
    verifyHttpsProofUrl(uri, label);
    return uri;
  }

  if (/^(s3:\/\/[^ ]+|rclone:[^ ]+)$/i.test(uri)) {
    return uri;
  }

  fail(`${label} must be a retained proof URI: https://..., s3://..., or rclone:<remote:path>.`);
}

function verifyTimestamp(value, label) {
  const timestamp = requireString(value, label);
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) {
    fail(`${label} must be an ISO timestamp.`);
  }
  return { timestamp, time };
}

function verifySha256(value, label) {
  const digest = requireString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    fail(`${label} must be a sha256 hex digest.`);
  }
  return digest;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPublicBuildConfig(values) {
  const normalizedValues = Object.fromEntries(
    publicBuildConfigKeys.map((key) => [key, String(values[key] ?? '')]),
  );
  return JSON.stringify({ keys: publicBuildConfigKeys, values: normalizedValues });
}

function requirePublicBuildValue(values, key, { allowEmpty = false } = {}) {
  const value = String(values[key] ?? '').trim();
  if (!value && !allowEmpty) {
    fail(`publicBuildConfig.values.${key} is required.`);
  }
  return value;
}

function verifyPublicBuildEmail(values, key) {
  const value = requirePublicBuildValue(values, key);
  if (!value) return;

  const match = value.match(/^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+)$/);
  const host = match?.[1]?.toLowerCase();
  if (!host || !isPublicProofHostname(host)) {
    fail(`publicBuildConfig.values.${key} must use a real public mailbox domain.`);
  }
}

function verifyPublicBuildHttpsUrl(values, key) {
  const value = requirePublicBuildValue(values, key);
  if (!value) return;

  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`publicBuildConfig.values.${key} must be a valid HTTPS URL.`);
    return;
  }

  if (url.protocol !== 'https:' || !isPublicProofHostname(url.hostname)) {
    fail(`publicBuildConfig.values.${key} must use https and a real public hostname.`);
  }
}

function verifyPublicBuildConfig(config) {
  if (!isObject(config)) {
    fail('publicBuildConfig is required in the release manifest.');
  }

  if (!Array.isArray(config.keys) || config.keys.join('\n') !== publicBuildConfigKeys.join('\n')) {
    fail(`publicBuildConfig.keys must exactly match: ${publicBuildConfigKeys.join(', ')}`);
  }

  if (!isObject(config.values)) {
    fail('publicBuildConfig.values is required.');
  }

  const sha256 = verifySha256(config.sha256, 'publicBuildConfig.sha256');
  const values = Object.fromEntries(
    publicBuildConfigKeys.map((key) => [key, String(config.values?.[key] ?? '')]),
  );
  const expectedSha256 = sha256Hex(canonicalPublicBuildConfig(values));
  if (sha256 !== expectedSha256) {
    fail(`publicBuildConfig.sha256 does not match manifest public build values; expected ${expectedSha256}.`);
  }

  const apiUrl = requirePublicBuildValue(values, 'NEXT_PUBLIC_API_URL');
  if (apiUrl && !apiUrl.startsWith('/api/')) {
    verifyPublicBuildHttpsUrl(values, 'NEXT_PUBLIC_API_URL');
  }

  const oidcEnabled = requirePublicBuildValue(values, 'NEXT_PUBLIC_OIDC_ENABLED').toLowerCase();
  if (!['true', 'false'].includes(oidcEnabled)) {
    fail('publicBuildConfig.values.NEXT_PUBLIC_OIDC_ENABLED must be true or false.');
  }

  const signupMode = requirePublicBuildValue(values, 'NEXT_PUBLIC_SIGNUP_MODE');
  if (!['closed_beta', 'invite_only', 'open'].includes(signupMode)) {
    fail('publicBuildConfig.values.NEXT_PUBLIC_SIGNUP_MODE must be closed_beta, invite_only, or open.');
  }
  const turnstileSiteKey = requirePublicBuildValue(values, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', { allowEmpty: true });
  if (signupMode === 'open' && (turnstileSiteKey.length < 20 || /test|placeholder|dummy|default|turnstile/i.test(turnstileSiteKey))) {
    fail('publicBuildConfig.values.NEXT_PUBLIC_TURNSTILE_SITE_KEY must be a real Turnstile site key when signup is open.');
  }

  verifyPublicBuildEmail(values, 'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL');
  verifyPublicBuildEmail(values, 'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL');
  verifyPublicBuildEmail(values, 'NEXT_PUBLIC_DPA_CONTACT_EMAIL');
  verifyPublicBuildHttpsUrl(values, 'NEXT_PUBLIC_APP_ORIGIN');
  verifyPublicBuildHttpsUrl(values, 'NEXT_PUBLIC_APP_URL');

  if (requirePublicBuildValue(values, 'NEXT_PUBLIC_APP_ENV') !== 'production') {
    fail('publicBuildConfig.values.NEXT_PUBLIC_APP_ENV must be production.');
  }

  verifyPublicBuildConfigRuntimeMatch(values);
}

function parseEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`Unable to read production runtime env ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator === -1) {
      fail(`Invalid production runtime env line ${index + 1}: expected KEY=value.`);
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  return { parsed, contents };
}

function verifyPublicBuildConfigRuntimeMatch(values) {
  const runtimeEnvPath = process.env.PRODUCTION_RUNTIME_ENV_PATH || process.env.COMPOSE_SERVICE_ENV_FILE;
  if (!runtimeEnvPath) {
    return;
  }

  const { parsed, contents } = parseEnvFile(runtimeEnvPath);
  if (process.env.PRODUCTION_RUNTIME_ENV_SHA256) {
    const actualSha = sha256Hex(contents);
    if (actualSha !== process.env.PRODUCTION_RUNTIME_ENV_SHA256) {
      fail(`PRODUCTION_RUNTIME_ENV_SHA256 does not match ${runtimeEnvPath}.`);
    }
  }

  for (const key of publicBuildConfigKeys) {
    const runtimeValue = String(parsed[key] ?? '');
    if (runtimeValue !== values[key]) {
      fail(`publicBuildConfig.values.${key} must match the validated production runtime env.`);
    }
  }
}

function verifyPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return number;
}

function verifyEntrySourceSha(value, label, sourceSha) {
  const entrySourceSha = requireString(value, label);
  if (entrySourceSha !== sourceSha) {
    fail(`${label} ${entrySourceSha} does not match launchProof.sourceSha ${sourceSha}.`);
  }
}

function verifyCommandProof(value, label) {
  const command = requireString(value, label);
  if (command.length < 12) {
    fail(`${label} must name the command or external check that generated the proof.`);
  }
  if (placeholderProofPattern.test(command)) {
    fail(`${label} must not contain placeholder proof text.`);
  }
}

function verifyExitCode(value, label) {
  const exitCode = Number(value);
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    fail(`${label} must be 0 for retained launch proof.`);
  }
}

function verifyFreshTimestamp(timestamp, label, verificationTime, maxAgeSeconds) {
  if (timestamp.time > verificationTime.time + 300_000) {
    fail(`${label} must not be more than five minutes in the future.`);
  }
  if (verificationTime.time - timestamp.time > maxAgeSeconds * 1_000) {
    fail(`${label} exceeds the maximum launch-proof age of ${maxAgeSeconds} seconds.`);
  }
}

function verifyLaunchProofEntry(evidence, key, sourceSha, generatedAt, seenUris, verificationTime, maxAgeSeconds, requireFreshness) {
  const entry = evidence[key];
  if (!isObject(entry)) {
    fail(`launchProof.evidence.${key} is required.`);
  }

  if (entry.skipped === true) {
    fail(`launchProof.evidence.${key} must not be marked skipped.`);
  }

  const status = requireString(entry.status, `launchProof.evidence.${key}.status`).toLowerCase();
  if (!['ok', 'passed'].includes(status)) {
    fail(`launchProof.evidence.${key}.status must be ok or passed, got ${status}.`);
  }

  const uri = verifyProofUri(entry.uri, `launchProof.evidence.${key}.uri`, { requireJson: key === 'drDrill' || key === 'pitrDrill' });
  if (seenUris.has(uri)) {
    fail(`launchProof.evidence.${key}.uri must be unique; ${uri} is reused.`);
  }
  seenUris.add(uri);

  const checkedAt = verifyTimestamp(entry.checkedAt, `launchProof.evidence.${key}.checkedAt`);
  if (checkedAt.time > generatedAt.time) {
    fail(`launchProof.evidence.${key}.checkedAt must not be later than launchProof.generatedAt.`);
  }
  if (requireFreshness) {
    verifyFreshTimestamp(
      checkedAt,
      `launchProof.evidence.${key}.checkedAt`,
      verificationTime,
      maxAgeSeconds,
    );
  }

  const summary = requireString(entry.summary, `launchProof.evidence.${key}.summary`);
  if (summary.length < 20) {
    fail(`launchProof.evidence.${key}.summary must describe the proof.`);
  }

  verifyEntrySourceSha(entry.sourceSha, `launchProof.evidence.${key}.sourceSha`, sourceSha);
  verifyCommandProof(entry.command, `launchProof.evidence.${key}.command`);
  verifyExitCode(entry.exitCode, `launchProof.evidence.${key}.exitCode`);
  verifySha256(entry.artifactSha256, `launchProof.evidence.${key}.artifactSha256`);
  verifyPositiveInteger(entry.artifactBytes, `launchProof.evidence.${key}.artifactBytes`);

  return entry;
}

function verifyLaunchProofFile(path, sourceSha, verificationTime, maxAgeSeconds, mode) {
  const proof = readManifest(path);
  if (!isObject(proof)) {
    fail('Launch proof must be a JSON object.');
  }

  if (proof.version !== 1) {
    fail('launchProof.version must be 1.');
  }

  const proofSourceSha = requireString(proof.sourceSha, 'launchProof.sourceSha');
  if (proofSourceSha !== sourceSha) {
    fail(`launchProof.sourceSha ${proofSourceSha} does not match release sourceSha ${sourceSha}.`);
  }

  const generatedAt = verifyTimestamp(proof.generatedAt, 'launchProof.generatedAt');
  const requireFreshness = mode === 'candidate';
  if (requireFreshness) {
    verifyFreshTimestamp(generatedAt, 'launchProof.generatedAt', verificationTime, maxAgeSeconds);
  }

  if (!isObject(proof.evidence)) {
    fail('launchProof.evidence is required.');
  }
  if (Object.hasOwn(proof.evidence, 'externalHealth')) {
    fail('Pre-deploy launch proof must not contain externalHealth; deployed release identity is verified only by the post-deploy gate.');
  }

  const seenUris = new Set();
  for (const key of requiredLaunchProofEntries) {
    verifyLaunchProofEntry(
      proof.evidence,
      key,
      proofSourceSha,
      generatedAt,
      seenUris,
      verificationTime,
      maxAgeSeconds,
      requireFreshness,
    );
  }

  const drDrill = proof.evidence.drDrill;
  verifySha256(drDrill.backupSha256, 'launchProof.evidence.drDrill.backupSha256');
  verifyPositiveInteger(drDrill.restoredTableCount, 'launchProof.evidence.drDrill.restoredTableCount');

  verifyProofUri(drDrill.sourceUri, 'launchProof.evidence.drDrill.sourceUri');

  const pitrDrill = proof.evidence.pitrDrill;
  const baseBackupId = requireString(pitrDrill.baseBackupId, 'launchProof.evidence.pitrDrill.baseBackupId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(baseBackupId) || /(^|[._-])(latest|current)([._-]|$)/i.test(baseBackupId)) {
    fail('launchProof.evidence.pitrDrill.baseBackupId must name one explicit retained backup.');
  }
  verifyProofUri(pitrDrill.baseBackupUri, 'launchProof.evidence.pitrDrill.baseBackupUri');
  const walSegment = requireString(pitrDrill.archivedWalSegment, 'launchProof.evidence.pitrDrill.archivedWalSegment');
  if (!/^[A-F0-9]{24}$/i.test(walSegment)) {
    fail('launchProof.evidence.pitrDrill.archivedWalSegment must be a WAL segment name.');
  }
  verifyProofUri(pitrDrill.archivedWalUri, 'launchProof.evidence.pitrDrill.archivedWalUri');
  verifyTimestamp(pitrDrill.recoveryTargetTime, 'launchProof.evidence.pitrDrill.recoveryTargetTime');
  verifyTimestamp(pitrDrill.sourceTimestamp, 'launchProof.evidence.pitrDrill.sourceTimestamp');

}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function verifyImmutableImageRef(ref, label) {
  if (/\$\{|\$[A-Z_]/.test(ref)) {
    fail(`${label} must be a resolved image reference, got ${ref}.`);
  }

  if (!digestSuffixPattern.test(ref)) {
    fail(`${label} must pin the image with an immutable sha256 digest, got ${ref}.`);
  }

  for (const { pattern, message } of forbiddenCommandPatterns) {
    if (pattern.test(ref)) {
      fail(`${label} ${message}.`);
    }
  }
}

function verifyDockerfileBaseImages(dockerfileDir) {
  let dockerfiles;
  try {
    dockerfiles = readdirSync(dockerfileDir)
      .filter((entry) => entry.startsWith('Dockerfile.'))
      .map((entry) => join(dockerfileDir, entry))
      .filter((path) => statSync(path).isFile());
  } catch (error) {
    fail(`Unable to list Dockerfiles in ${dockerfileDir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (dockerfiles.length === 0) {
    fail(`No Dockerfile.* files found in ${dockerfileDir}.`);
  }

  for (const dockerfile of dockerfiles) {
    const lines = readText(dockerfile, 'Dockerfile').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?\s*$/i);
      if (!match) {
        continue;
      }

      const ref = match[1];
      if (ref.toLowerCase() === 'scratch') {
        continue;
      }

      verifyImmutableImageRef(ref, `${dockerfile}:${index + 1} base image`);
    }
  }
}

function verifyComposeThirdPartyImages(composeFile) {
  const lines = readText(composeFile, 'Compose file').split(/\r?\n/);
  let currentService = 'unknown';
  let checkedImages = 0;

  for (const [index, line] of lines.entries()) {
    const serviceMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      continue;
    }

    const imageMatch = line.match(/^\s{4}image:\s*(.+?)\s*$/);
    if (!imageMatch) {
      continue;
    }

    const ref = unquoteYamlScalar(imageMatch[1]);
    if (appComposeImagePattern.test(ref)) {
      continue;
    }

    checkedImages += 1;
    verifyImmutableImageRef(ref, `${composeFile}:${index + 1} ${currentService} image`);
  }

  if (checkedImages === 0) {
    fail(`${composeFile} did not contain any third-party Compose images to verify.`);
  }
}

function verifyWorkflowServiceImages(workflowFile) {
  const lines = readText(workflowFile, 'workflow file').split(/\r?\n/);
  let checkedImages = 0;

  for (const [index, line] of lines.entries()) {
    const imageMatch = line.match(/^ {8}image:\s*(.+?)\s*$/);
    if (!imageMatch) {
      continue;
    }

    checkedImages += 1;
    verifyImmutableImageRef(unquoteYamlScalar(imageMatch[1]), `${workflowFile}:${index + 1} CI service image`);
  }

  if (checkedImages === 0) {
    fail(`${workflowFile} did not contain any CI service images to verify.`);
  }
}

const fixedProductionAggregateLines = Object.freeze([
  'set -euo pipefail',
  'test -n "$VM217_HOST"',
  'test -n "$VM217_USER"',
  'test -n "$VM217_SSH_PRIVATE_KEY"',
  'test -n "$VM217_SSH_KNOWN_HOSTS"',
  'private_key="$RUNNER_TEMP/lunchlineup-vm217-private-key"',
  'known_hosts="$RUNNER_TEMP/lunchlineup-vm217-known-hosts"',
  'launch_proof="$RUNNER_TEMP/lunchlineup-deployed-inputs/launch-proof.json"',
  'rm -f "$private_key" "$known_hosts"',
  'install -m 600 /dev/null "$private_key"',
  'install -m 600 /dev/null "$known_hosts"',
  'printf \'%s\\n\' "$VM217_SSH_PRIVATE_KEY" > "$private_key"',
  'printf \'%s\\n\' "$VM217_SSH_KNOWN_HOSTS" > "$known_hosts"',
  'unset VM217_SSH_PRIVATE_KEY VM217_SSH_KNOWN_HOSTS',
  'test -s "$launch_proof"',
  'deploy_status=0',
  'mutation_seconds="$(node scripts/validate-production-deploy-deadlines.mjs remaining --phase mutation --maximum-seconds "$VM217_MUTATION_BUDGET_SECONDS")" || deploy_status=$?',
  'if [ "$deploy_status" -eq 0 ]; then',
  'timeout --signal=TERM --kill-after="${PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS}s" "${mutation_seconds}s" env VM217_MUTATION_BUDGET_SECONDS="$mutation_seconds" VM217_SSH_COMMAND_TIMEOUT_SECONDS="$mutation_seconds" PRODUCTION_API_HEALTH_URL="$PRODUCTION_API_HEALTH_URL" PRODUCTION_WEB_URL="$PRODUCTION_WEB_URL" LAUNCH_PROOF_MANIFEST_URI="$LAUNCH_PROOF_MANIFEST_URI" EXPECTED_CURRENT_RELEASE_SHA="$EXPECTED_CURRENT_RELEASE_SHA" bash scripts/deploy-vm217-transport.sh --host "$VM217_HOST" --user "$VM217_USER" --private-key "$private_key" --known-hosts "$known_hosts" --release-manifest "$RELEASE_MANIFEST_PATH" --runtime-env "$PRODUCTION_RUNTIME_ENV_PATH" --launch-proof "$launch_proof" --source-sha "$RELEASE_SOURCE_SHA" || deploy_status=$?',
  'fi',
  'reconcile_status=0',
  'reconciliation_seconds="$(node scripts/validate-production-deploy-deadlines.mjs remaining --phase reconciliation --maximum-seconds "$PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS")" || reconcile_status=$?',
  'if [ "$reconcile_status" -eq 0 ]; then',
  'timeout --signal=TERM --kill-after="${PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS}s" "${reconciliation_seconds}s" env VM217_RECONCILE_ONLY=true env VM217_SSH_RECONCILE_TIMEOUT_SECONDS="$reconciliation_seconds" PRODUCTION_API_HEALTH_URL="$PRODUCTION_API_HEALTH_URL" PRODUCTION_WEB_URL="$PRODUCTION_WEB_URL" LAUNCH_PROOF_MANIFEST_URI="$LAUNCH_PROOF_MANIFEST_URI" EXPECTED_CURRENT_RELEASE_SHA="$EXPECTED_CURRENT_RELEASE_SHA" bash scripts/deploy-vm217-transport.sh --host "$VM217_HOST" --user "$VM217_USER" --private-key "$private_key" --known-hosts "$known_hosts" --release-manifest "$RELEASE_MANIFEST_PATH" --runtime-env "$PRODUCTION_RUNTIME_ENV_PATH" --launch-proof "$launch_proof" --source-sha "$RELEASE_SOURCE_SHA" || reconcile_status=$?',
  'fi',
  'cleanup_status=0',
  'clone_driver="$RUNNER_TEMP/lunchlineup-compatibility-clone-driver.sh"',
  'clone_env="$RUNNER_TEMP/lunchlineup-compatibility-clone.env"',
  'clone_suffix="$(printf \'%s\' "deploy:$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" | sha256sum | cut -c1-12)"',
  'clone_id="llc-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$clone_suffix"',
  'if [ -f "$clone_driver" ]; then',
  'cleanup_seconds="$(node scripts/validate-production-deploy-deadlines.mjs remaining --phase cleanup --maximum-seconds "$PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS")" || cleanup_status=$?',
  'if [ "$cleanup_status" -eq 0 ]; then',
  'timeout --signal=TERM --kill-after="${PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS}s" "${cleanup_seconds}s" bash scripts/destroy-old-release-compatibility-clone.sh --driver "$clone_driver" --clone-env "$clone_env" --clone-id "$clone_id" --production-runtime-env "${PRODUCTION_RUNTIME_ENV_PATH:-}" --timeout-seconds "$cleanup_seconds" || cleanup_status=$?',
  'fi',
  'fi',
  'rm -f "$private_key" "$known_hosts"',
  'rm -rf "$RUNNER_TEMP/old-release-compatibility-evidence"',
  'rm -f "$RUNNER_TEMP/lunchlineup-runtime.env" "$RUNNER_TEMP/lunchlineup-previous-runtime.env"',
  'if [ -n "${PREVIOUS_RELEASE_MANIFEST_PATH:-}" ]; then',
  'rm -rf "$(dirname "$PREVIOUS_RELEASE_MANIFEST_PATH")"',
  'fi',
  'if [ "$deploy_status" -ne 0 ]; then exit "$deploy_status"; fi',
  'if [ "$reconcile_status" -ne 0 ]; then exit "$reconcile_status"; fi',
  'exit "$cleanup_status"',
]);

function normalizedWorkflowShellLines(source) {
  return source
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter(Boolean);
}

function verifyFixedProductionAggregate(aggregate, workflowFile) {
  const actualLines = normalizedWorkflowShellLines(aggregate.slice(aggregate.indexOf('run: |') + 'run: |'.length));
  if (actualLines.length !== fixedProductionAggregateLines.length
    || actualLines.some((line, index) => line !== fixedProductionAggregateLines[index])) {
    fail(`${workflowFile} normal production deploy must contain only the exact fixed transport orchestration; shell construction, indirection, sourced helpers, and added executable commands are forbidden.`);
  }
}

function verifyProductionDeployDeadlineOwner(workflowFile) {
  const workflow = readText(workflowFile, 'workflow file');
  const jobStart = workflow.indexOf('\n  deploy-production:');
  const jobEnd = workflow.indexOf('\n  production-image-inventory:', jobStart);
  if (jobStart < 0 || jobEnd <= jobStart) {
    fail(`${workflowFile} must contain the normal production release transaction job.`);
  }
  const job = workflow.slice(jobStart, jobEnd);
  if (/\n  production-(?:smoke|rollback):/.test(workflow)) {
    fail(`${workflowFile} normal production deploy, smoke, publication, and automatic rollback must share one protected production job.`);
  }
  if (/PRODUCTION_DEPLOY_COMMAND|lunchlineup-deploy-production\.sh/.test(job)) {
    fail(`${workflowFile} normal production deploy must not trust mutable command text or a runner-temporary deploy helper.`);
  }
  const requiredPatterns = [
    [/timeout-minutes:\s*180\b/, 'reserve one bounded outer window for deploy, smoke, publication, and automatic rollback'],
    [/environment:\s*production\b/, 'use one protected production environment approval for the complete release transaction'],
    [/PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS:\s*'10800'/, 'declare the exact release transaction deadline in seconds'],
    [/PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS:\s*'5400'/, 'declare the exact deploy phase deadline in seconds'],
    [/PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS:\s*'900'/, 'reserve time after automatic rollback mutation for proof and cleanup'],
    [/PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS:\s*'120'/, 'bound the distinct compatibility preflight'],
    [/Capture production deploy runner deadline origin[\s\S]*date \+%s/, 'capture its deadline origin before checkout and setup'],
    [/validate-production-deploy-deadlines\.mjs start --github-env "\$GITHUB_ENV"/, 'start the checked-in aggregate deadline owner'],
    [/id:\s*production_deploy[\s\S]*if:\s*\$\{\{ !cancelled\(\) && steps\.arm_production_rollback\.outcome == 'success' \}\}/, 'refuse to start candidate mutation after workflow cancellation'],
    [/validate-production-deploy-deadlines\.mjs remaining[\s\S]*--phase "\$1"[\s\S]*--maximum-seconds "\$2"/, 'debit elapsed setup and preflight time from each phase'],
    [/timeout[\s\S]*--signal=TERM[\s\S]*--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s"/, 'hard-kill TERM-ignoring phase commands'],
    [/VM217_HOST:\s*\$\{\{ vars\.VM217_HOST \}\}[\s\S]*VM217_USER:\s*\$\{\{ vars\.VM217_USER \}\}[\s\S]*VM217_SSH_PRIVATE_KEY:\s*\$\{\{ secrets\.VM217_SSH_PRIVATE_KEY \}\}[\s\S]*VM217_SSH_KNOWN_HOSTS:\s*\$\{\{ secrets\.VM217_SSH_KNOWN_HOSTS \}\}/, 'bind explicit protected host, user, private-key, and pinned known-host inputs'],
    [/phase_seconds compatibility "\$PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS"/, 'derive compatibility clone provisioning from the remaining absolute deadline'],
    [/phase_seconds compatibility "\$PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS"/, 'derive compatibility preflight from the remaining absolute deadline'],
    [/phase_seconds compatibility "\$PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS"/, 'derive compatibility provider execution from the remaining absolute deadline'],
    [/cleanup_compatibility_clone\(\)[\s\S]*phase_seconds compatibility-cleanup[\s\S]*trap cleanup_compatibility_clone EXIT/, 'reserve an always-run compatibility clone cleanup deadline'],
    [/destroy-old-release-compatibility-clone\.sh[\s\S]*--timeout-seconds "\$cleanup_seconds"/, 'run bounded clone cleanup before returning from the aggregate step'],
    [/--phase runner-cleanup[\s\S]*--maximum-seconds "\$PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS"/, 'retain an absolute runner-cutoff cleanup fallback for preflight failures'],
    [/id:\s*production_smoke[\s\S]*id:\s*publish_release[\s\S]*id:\s*same_gate_release_outcome/, 'run smoke, publication, and release-outcome ownership after the deploy in the same protected job'],
    [/id:\s*same_gate_release_outcome[\s\S]*if:\s*always\(\) && steps\.arm_production_rollback\.outcome == 'success'/, 'evaluate every post-arm release outcome even after a failed step'],
    [/id:\s*materialize_automatic_rollback[\s\S]*steps\.same_gate_release_outcome\.outcome != 'success'[\s\S]*id:\s*automatic_production_rollback[\s\S]*id:\s*prove_automatic_production_rollback/, 'fail closed into materialization, rollback, and independent rollback proof'],
    [/automatic-rollback-cutoff[\s\S]*export VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS="\$rollback_mutation_not_after"[\s\S]*rollback-vm217-transport\.sh/, 'replace the deploy cutoff with a transaction-bounded automatic rollback cutoff'],
    [/Require completed automatic rollback after release failure[\s\S]*ROLLBACK_PROOF_OUTCOME[\s\S]*test "\$ROLLBACK_PROOF_OUTCOME" = success/, 'require every automatic rollback phase to complete successfully'],
  ];
  for (const [pattern, requirement] of requiredPatterns) {
    if (!pattern.test(job)) fail(`${workflowFile} normal production deploy must ${requirement}.`);
  }
  const aggregateStart = job.indexOf('17. Guarded production deploy; Reconcile exact VM217');
  const aggregateEnd = job.indexOf('\n      - name: Verify deployed release inputs remain exact', aggregateStart);
  const aggregate = job.slice(aggregateStart, aggregateEnd);
  if (aggregateStart < 0 || aggregateEnd <= aggregateStart || aggregate.includes('--foreground')) {
    fail(`${workflowFile} normal production deploy timeout must own the external command process group.`);
  }
  verifyFixedProductionAggregate(aggregate, workflowFile);

  const compatibilityStart = job.indexOf('Execute previous release against candidate schema clone');
  const compatibilityEnd = job.indexOf('\n      - name: Retain executable old-release compatibility evidence', compatibilityStart);
  const compatibility = job.slice(compatibilityStart, compatibilityEnd);
  const cleanupTrap = compatibility.indexOf('trap cleanup_compatibility_clone EXIT');
  const preflight = compatibility.indexOf('node scripts/old-release-compatibility-harness.mjs preflight');
  const run = compatibility.indexOf('node scripts/old-release-compatibility-harness.mjs run');
  if (compatibilityStart < 0 || compatibilityEnd <= compatibilityStart
    || cleanupTrap < 0 || preflight <= cleanupTrap || run <= preflight
    || (compatibility.match(/old-release-compatibility-harness\.mjs preflight/g) ?? []).length !== 1
    || (compatibility.match(/old-release-compatibility-harness\.mjs run/g) ?? []).length !== 1
    || !/"\$\{preflight_seconds\}s"[\s\S]*node scripts\/old-release-compatibility-harness\.mjs preflight/.test(compatibility)) {
    fail(`${workflowFile} normal production compatibility must run one bounded preflight after clone cleanup is armed and before provider execution.`);
  }
  const normalizedAggregate = aggregate
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ');
  const fixedTransportInvocations = normalizedAggregate.match(
    /bash scripts\/deploy-vm217-transport\.sh --host "\$VM217_HOST" --user "\$VM217_USER" --private-key "\$private_key" --known-hosts "\$known_hosts" --release-manifest "\$RELEASE_MANIFEST_PATH" --runtime-env "\$PRODUCTION_RUNTIME_ENV_PATH" --launch-proof "\$launch_proof" --source-sha "\$RELEASE_SOURCE_SHA" (?=\|\|)/g,
  ) ?? [];
  if (fixedTransportInvocations.length !== 2
    || (normalizedAggregate.match(/deploy-vm217-transport\.sh/g) ?? []).length !== 2) {
    fail(`${workflowFile} normal production deploy must directly invoke scripts/deploy-vm217-transport.sh twice with every explicit protected and release input.`);
  }
  if (!/VM217_MUTATION_BUDGET_SECONDS="\$mutation_seconds"[\s\S]*bash scripts\/deploy-vm217-transport\.sh/.test(aggregate)) {
    fail(`${workflowFile} normal production mutation must run the fixed transport under the remaining mutation deadline.`);
  }
  if (!/VM217_RECONCILE_ONLY=true[\s\S]*bash scripts\/deploy-vm217-transport\.sh/.test(aggregate)) {
    fail(`${workflowFile} normal production reconciliation must run the fixed transport in exact-state reconcile mode.`);
  }

  const capture = job.indexOf('Capture production deploy runner deadline origin');
  const checkout = job.indexOf('actions/checkout@');
  const owner = job.indexOf('Start production deploy aggregate deadline');
  const setup = job.indexOf('actions/setup-node@');
  const mutation = job.indexOf('VM217_MUTATION_BUDGET_SECONDS="$mutation_seconds"');
  const reconciliation = job.indexOf('VM217_RECONCILE_ONLY=true');
  const cleanup = job.indexOf('destroy-old-release-compatibility-clone.sh', reconciliation);
  if (!(capture < checkout && checkout < owner && owner < setup
    && setup < mutation && mutation < reconciliation && reconciliation < cleanup)) {
    fail(`${workflowFile} normal production deploy deadline, mutation, reconciliation, and cleanup order is unsafe.`);
  }
  const smoke = job.indexOf('id: production_smoke');
  const publish = job.indexOf('id: publish_release');
  const outcome = job.indexOf('id: same_gate_release_outcome');
  const rollback = job.indexOf('id: automatic_production_rollback');
  const rollbackProof = job.indexOf('id: prove_automatic_production_rollback');
  const rollbackRequirement = job.indexOf('Require completed automatic rollback after release failure');
  if (!(cleanup < smoke && smoke < publish && publish < outcome
    && outcome < rollback && rollback < rollbackProof && rollbackProof < rollbackRequirement)) {
    fail(`${workflowFile} normal production release transaction step order is unsafe.`);
  }
}

function verifyImage(service, image, sourceSha) {
  if (!image || typeof image !== 'object') {
    fail(`images.${service} is required.`);
  }

  const ref = requireString(image.ref, `images.${service}.ref`);
  const digest = requireString(image.digest, `images.${service}.digest`);
  const dockerfile = requireString(image.dockerfile, `images.${service}.dockerfile`);
  const serviceName = service === 'migrate' ? 'migrate' : service;

  if (!dockerfile.startsWith('infrastructure/docker/Dockerfile.')) {
    fail(`images.${service}.dockerfile must point at infrastructure/docker.`);
  }

  if (/\$\{|\$IMAGE_TAG|\$GITHUB_SHA|\$RELEASE_SOURCE_SHA/.test(ref)) {
    fail(`images.${service}.ref must be a resolved immutable reference, got ${ref}.`);
  }

  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    fail(`images.${service}.digest must be a sha256 digest.`);
  }

  if (!ref.includes(`/${serviceName}:`)) {
    fail(`images.${service}.ref must include the ${serviceName} image name.`);
  }

  if (!ref.includes(`:${sourceSha}@${digest}`)) {
    fail(`images.${service}.ref must pin the ${sourceSha} tag to ${digest}.`);
  }

  if (!digestSuffixPattern.test(ref)) {
    fail(`images.${service}.ref must include an immutable digest.`);
  }

  for (const { pattern, message } of forbiddenCommandPatterns) {
    if (pattern.test(ref)) {
      fail(`images.${service}.ref ${message}.`);
    }
  }
}

function verifyManifest(manifest, expectedSourceSha, deploymentRoot) {
  if (!manifest || typeof manifest !== 'object') {
    fail('Release manifest must be a JSON object.');
  }

  const sourceSha = requireString(manifest.sourceSha, 'sourceSha');
  if (!/^[a-f0-9]{40}$/i.test(sourceSha)) {
    fail('sourceSha must be a full 40-character Git SHA.');
  }

  if (expectedSourceSha && expectedSourceSha !== sourceSha) {
    fail(`Manifest sourceSha ${sourceSha} does not match expected ${expectedSourceSha}.`);
  }

  for (const service of requiredServices) {
    verifyImage(service, manifest.images?.[service], sourceSha);
  }
  verifyPublicBuildConfig(manifest.publicBuildConfig);
  const productionHealthProof = verifyProductionHealthProof(manifest.productionHealthProof);
  const expectedContract = buildDeploymentContract(deploymentRoot);
  if (JSON.stringify(manifest.deploymentContract) !== JSON.stringify(expectedContract)) {
    fail('deploymentContract must exactly match the checked-in production Compose, scripts, and operational configuration files.');
  }

  return { sourceSha, productionHealthProof };
}

function verifyNoMutableCommand(command, label) {
  for (const { pattern, message } of forbiddenCommandPatterns) {
    if (pattern.test(command)) {
      fail(`${label} ${message}.`);
    }
  }

  for (const invocation of composeInvocations(command)) {
    for (const [flag, pattern] of [
      ['--project-name', /(^|\s)--project-name(?:=|\s+)(?:"[^"]+"|'[^']+'|(?!-)\S+)/i],
      ['--project-directory', /(^|\s)--project-directory(?:=|\s+)(?:"[^"]+"|'[^']+'|(?!-)\S+)/i],
      ['--env-file', /(^|\s)--env-file(?:=|\s+)(?:"[^"]+"|'[^']+'|(?!-)\S+)/i],
      ['-f', /(^|\s)-f(?:=|\s+)(?:"[^"]+"|'[^']+'|(?!-)\S+)/i],
    ]) {
      const occurrences = invocation.match(new RegExp(pattern.source, 'gi')) ?? [];
      if (occurrences.length === 0) {
        fail(`${label} uses docker compose without ${flag}.`);
      }
      if (occurrences.length !== 1) {
        fail(`${label} must use docker compose scope flag ${flag} exactly once.`);
      }
    }
  }

  for (const invocation of composeUpInvocations(command)) {
    if (!/(^|\s)--no-build(\s|$)/i.test(invocation)) {
      fail(`${label} uses docker compose up without --no-build.`);
    }

    if (!/(^|\s)--pull\s+never(\s|$)/i.test(invocation)) {
      fail(`${label} uses docker compose up without --pull never.`);
    }
  }
}

function composeInvocations(command) {
  const normalized = command
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/\r?\n/g, ' ');
  return normalized.match(/\bdocker(?:\s+compose|-compose)\b[^;&|]*/gi) ?? [];
}

function composeUpInvocations(command) {
  return composeInvocations(command)
    .filter((invocation) => /\bup\b/i.test(invocation));
}

function verifyDeployCommand(command, name, manifestPath) {
  const label = `${name} deploy command`;
  if (name === 'PRODUCTION_DEPLOY_COMMAND') {
    fail('PRODUCTION_DEPLOY_COMMAND is forbidden; normal production mutation must invoke checked-in scripts/deploy-vm217-transport.sh directly.');
  }
  const manifestName = basename(manifestPath);
  const normalizedCommand = command
    .trim()
    .replace(/^set\s+-euo\s+pipefail\s*;?\s*/i, '')
    .replace(/^(?:export\s+)?(?:RELEASE_SOURCE_SHA|RELEASE_MANIFEST_PATH)=[^\n;&|]+\s*;?\s*/gi, '');
  verifyNoMutableCommand(command, label);

  if (!/verify-deploy-source\.(?:sh|ps1)\b/i.test(command)) {
    fail(`${label} must run verify-deploy-source before server mutation.`);
  }

  if (!/^(?:\.\/)?scripts\/verify-deploy-source\.(?:sh|ps1)\s+["']?\$[{(]?RELEASE_SOURCE_SHA/i.test(normalizedCommand)) {
    fail(`${label} must start with verify-deploy-source and pass RELEASE_SOURCE_SHA before any server mutation.`);
  }

  if (!command.includes('RELEASE_SOURCE_SHA')) {
    fail(`${label} must pass RELEASE_SOURCE_SHA to verify-deploy-source.`);
  }

  if (!command.includes('RELEASE_MANIFEST_PATH') && !command.includes(manifestName)) {
    fail(`${label} must consume RELEASE_MANIFEST_PATH or ${manifestName}.`);
  }

}

function verifyRollbackCommand(command, name) {
  const label = `${name} rollback command`;
  verifyNoMutableCommand(command, label);

  if (!/ROLLBACK_DEPLOYMENT_APP_DIR/.test(command)) {
    fail(`${label} must consume the isolated previous release deployment root.`);
  }

  if (!/(PREVIOUS_RELEASE_MANIFEST_PATH|RELEASE_MANIFEST_PATH)/.test(command)) {
    fail(`${label} must consume the previous release manifest path.`);
  }
  if (!/(PREVIOUS_RELEASE_SOURCE_SHA|ROLLBACK_SOURCE_SHA|RELEASE_SOURCE_SHA)/.test(command)) {
    fail(`${label} must consume the rollback source SHA.`);
  }
  if (!/verify-release-artifacts\.mjs/.test(command) || !/--source-sha/.test(command)) {
    fail(`${label} must verify the rollback release manifest against its source SHA before mutation.`);
  }
  if (!/PRODUCTION_POST_DEPLOY_PROOF_COMMAND/.test(command)) {
    fail(`${label} must run or verify PRODUCTION_POST_DEPLOY_PROOF_COMMAND after rollback.`);
  }
  if (!/(PRODUCTION_API_HEALTH_URL|DEPLOYED_GIT_SHA|LAUNCH_PROOF_MANIFEST_URI)/.test(command)) {
    fail(`${label} must include post-rollback health and proof gates.`);
  }
  if (!/VM217_DEPLOY_OPERATION/.test(command) || !/rollback/.test(command)) {
    fail(`${label} must explicitly select VM217_DEPLOY_OPERATION=rollback.`);
  }
  if (!/ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM/.test(command)) {
    fail(`${label} must provide the SHA-bound rollback schema compatibility confirmation.`);
  }
}

function verifyPostDeployProofCommand(command, name) {
  const label = `${name} post-deploy proof command`;
  const normalized = requireString(command, name);
  verifyNoMutableCommand(normalized, label);
  verifyCommandProof(normalized, label);

  if (!/DEPLOYED_GIT_SHA/.test(normalized) || !/RELEASE_SOURCE_SHA/.test(normalized)) {
    fail(`${label} must compare the deployed DEPLOYED_GIT_SHA against RELEASE_SOURCE_SHA.`);
  }
  if (!/(DEPLOYED_GIT_SHA[\s\S]{0,200}RELEASE_SOURCE_SHA|RELEASE_SOURCE_SHA[\s\S]{0,200}DEPLOYED_GIT_SHA)/.test(normalized)) {
    fail(`${label} must compare DEPLOYED_GIT_SHA and RELEASE_SOURCE_SHA in the same check.`);
  }
  if (!/\bcurl\b[\s\S]{0,120}\$?PRODUCTION_API_HEALTH_URL/.test(normalized)) {
    fail(`${label} must run a public API health proof using PRODUCTION_API_HEALTH_URL.`);
  }
  if (!/LAUNCH_PROOF_MANIFEST_URI/.test(normalized)) {
    fail(`${label} must retain or verify the LAUNCH_PROOF_MANIFEST_URI artifact reference.`);
  }
  if (!/\bsha256sum\b|artifactSha256/.test(normalized)) {
    fail(`${label} must compute or verify a retained proof checksum.`);
  }
  if (!/(stat\s+-c%s|wc\s+-c|artifactBytes)/.test(normalized)) {
    fail(`${label} must prove retained proof artifact size is nonzero.`);
  }
  if (!/LAUNCH_PROOF_ARTIFACT_SHA256/.test(normalized)) {
    fail(`${label} must compare the downloaded launch proof to LAUNCH_PROOF_ARTIFACT_SHA256.`);
  }
  if (!/LAUNCH_PROOF_MAX_AGE_SECONDS/.test(normalized)) {
    fail(`${label} must enforce LAUNCH_PROOF_MAX_AGE_SECONDS.`);
  }
}

const options = parseArgs(process.argv.slice(2));
const manifest = readManifest(options.manifestPath);
const { sourceSha, productionHealthProof } = verifyManifest(manifest, options.sourceSha, options.deploymentRoot);
verifyDockerfileBaseImages(options.dockerfileDir);
verifyComposeThirdPartyImages(options.composeFile);
verifyWorkflowServiceImages(options.workflowFile);
if (options.launchProofMode === 'candidate') verifyProductionDeployDeadlineOwner(options.workflowFile);
if (options.launchProofFile) {
  verifyLaunchProofFile(
    options.launchProofFile,
    sourceSha,
    options.verificationTime,
    options.maxProofAgeSeconds,
    options.launchProofMode,
  );
}

for (const name of options.commandEnvNames) {
  const command = requireString(process.env[name], name);
  verifyDeployCommand(command, name, options.manifestPath);
}

for (const name of options.rollbackCommandEnvNames) {
  const command = requireString(process.env[name], name);
  verifyRollbackCommand(command, name);
}

for (const name of options.postDeployProofCommandEnvNames) {
  const command = requireString(process.env[name], name);
  verifyPostDeployProofCommand(command, name);
}

for (const name of options.productionApiHealthUrlEnvNames) {
  verifyProductionHealthUrlEnvironment(productionHealthProof, name);
}

console.log(`release_artifacts_ok sha=${sourceSha} services=${requiredServices.join(',')} launch_proof=${options.launchProofFile ? options.launchProofMode : 'not_checked'}`);
