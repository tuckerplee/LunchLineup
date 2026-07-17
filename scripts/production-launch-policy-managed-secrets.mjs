import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PLACEHOLDER_RE } from './production-launch-policy-shared.mjs';

const COMPOSE_SECRET_SOURCE_KEYS = [
  'CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE',
  'METRICS_TOKEN_FILE',
  'RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE',
  'ALERTMANAGER_WEBHOOK_URL_FILE',
  'BACKUP_ENCRYPTION_KEY_SECRET_FILE',
];

function isPathWithin(parent, candidate) {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function assertEncoded32ByteSecret(context, key) {
  const { collector, assertRequired } = context;
  const value = assertRequired(key);
  if (!value) return;
  if (PLACEHOLDER_RE.test(value)) {
    collector.fail(`${key} must be a non-placeholder 32-byte hex or base64 secret.`);
    return;
  }
  if (/^[a-f0-9]{64}$/i.test(value)) {
    collector.pass(key);
    return;
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) {
    collector.fail(`${key} must be a 32-byte hex or base64 secret.`);
    return;
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length !== 32) {
      collector.fail(`${key} must decode to exactly 32 bytes.`);
      return;
    }
    collector.pass(key);
  } catch {
    collector.fail(`${key} must be a valid 32-byte hex or base64 secret.`);
  }
}

function decodeEncoded32ByteSecret(value) {
  const configured = String(value ?? '').trim();
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length !== 32) return null;
    if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function createManagedSecretPolicy(context, {
  repoLocalSecretsRoot,
  verifyLocalSecretFiles,
}) {
  const { env, collector } = context;

  function assertAbsoluteManagedSecretPath(key, value, kind) {
    if (!value) {
      collector.fail(`${key} is required and must point at a managed secret ${kind}.`);
      return null;
    }
    if (!isAbsolute(value)) {
      collector.fail(`${key} must be an absolute managed-secret ${kind === 'file' ? 'path' : 'directory'}, not a repo-relative path.`);
      return null;
    }
    if (isPathWithin(repoLocalSecretsRoot, resolve(value))) {
      collector.fail(`${key} cannot point at the repo-local secrets directory for public launch.`);
      return null;
    }
    collector.pass(key);
    return value;
  }

  function assertAbsoluteSecretFile(key) {
    return assertAbsoluteManagedSecretPath(key, String(env[key] ?? '').trim(), 'file');
  }

  function assertAbsoluteSecretDirectory(key) {
    return assertAbsoluteManagedSecretPath(key, String(env[key] ?? '').trim(), 'directory');
  }

  function canonicalManagedSecretPath(path) {
    let canonical = resolve(path);
    if (verifyLocalSecretFiles && existsSync(canonical)) {
      try {
        canonical = realpathSync.native(canonical);
      } catch {
        // The readability check reports inaccessible files with the owning role.
      }
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }

  function validateSecretValues() {
    for (const key of [
      'POSTGRES_PASSWORD',
      'APP_DB_PASSWORD',
      'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
      'RABBITMQ_PASSWORD',
      'GRAFANA_PASSWORD',
      'CONTROL_PLANE_PASSWORD',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'SESSION_SECRET',
      'CSRF_SECRET',
      'MFA_SECRET_ENCRYPTION_KEY_CURRENT',
    ]) {
      context.assertSecret(key);
    }
    assertEncoded32ByteSecret(context, 'MFA_SECRET_ENCRYPTION_KEY_CURRENT');
    if (String(env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS ?? '').trim()) {
      assertEncoded32ByteSecret(context, 'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS');
      if (env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS === env.MFA_SECRET_ENCRYPTION_KEY_CURRENT) {
        collector.fail('MFA_SECRET_ENCRYPTION_KEY_PREVIOUS must differ from MFA_SECRET_ENCRYPTION_KEY_CURRENT.');
      }
    }
    assertEncoded32ByteSecret(context, 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT');
    if (String(env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? '').trim()) {
      assertEncoded32ByteSecret(context, 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS');
      if (env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS === env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT) {
        collector.fail('WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS must differ from WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT.');
      }
    }
    assertEncoded32ByteSecret(context, 'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY');
    assertEncoded32ByteSecret(context, 'AVAILABILITY_IMPORT_ENCRYPTION_KEY');
    assertEncoded32ByteSecret(context, 'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY');

    const payloadKeyRoles = [
      'MFA_SECRET_ENCRYPTION_KEY_CURRENT',
      'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS',
      'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
      'WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS',
      'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY',
      'AVAILABILITY_IMPORT_ENCRYPTION_KEY',
      'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY',
    ];
    const payloadKeys = new Map();
    for (const role of payloadKeyRoles) {
      const decoded = decodeEncoded32ByteSecret(env[role]);
      if (!decoded) continue;
      const fingerprint = createHash('sha256').update(decoded).digest('hex');
      const duplicateRole = payloadKeys.get(fingerprint);
      if (duplicateRole) {
        collector.fail(`${role} must not reuse encryption key material from ${duplicateRole}.`);
      } else {
        payloadKeys.set(fingerprint, role);
      }
    }
  }

  function collectComposeSecretFiles() {
    const files = COMPOSE_SECRET_SOURCE_KEYS
      .map((role) => ({ role, path: assertAbsoluteSecretFile(role) }))
      .filter(({ path }) => path);
    assertAbsoluteSecretFile('CONTROL_PLANE_ADMIN_TOKEN_FILE');
    return files;
  }

  function validateIsolation(files) {
    const paths = new Map();
    const canonicalRepoSecretsRoot = canonicalManagedSecretPath(repoLocalSecretsRoot);
    for (const file of files) {
      const canonicalPath = canonicalManagedSecretPath(file.path);
      if (isPathWithin(canonicalRepoSecretsRoot, canonicalPath)) {
        collector.fail(`${file.role} cannot resolve into the repo-local secrets directory for public launch.`);
      }
      const duplicateRole = paths.get(canonicalPath);
      if (duplicateRole) {
        collector.fail(`${duplicateRole} must use a separate managed secret file from ${file.role}.`);
      } else {
        paths.set(canonicalPath, file.role);
      }
    }

    if (!verifyLocalSecretFiles) return;

    const credentials = new Map();
    for (const file of files) {
      let content;
      try {
        accessSync(file.path, constants.R_OK);
        if (!statSync(file.path).isFile()) throw new Error('not a file');
        content = readFileSync(file.path);
      } catch {
        collector.fail(`${file.role} must exist and be a readable file on the deployment host.`);
        continue;
      }

      const identity = `${content.byteLength}:${createHash('sha256').update(content).digest('hex')}`;
      const duplicateRole = credentials.get(identity);
      if (duplicateRole) {
        collector.fail(`${file.role} must not reuse credential material from ${duplicateRole}.`);
      } else {
        credentials.set(identity, file.role);
      }
    }
  }

  return {
    assertAbsoluteManagedSecretPath,
    assertAbsoluteSecretDirectory,
    canonicalManagedSecretPath,
    validateSecretValues,
    collectComposeSecretFiles,
    validateIsolation,
  };
}
