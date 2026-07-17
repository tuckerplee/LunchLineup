#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  validateBackupPitrPolicy,
  validateRecoveryEvidencePolicy,
} from './production-launch-policy-backup-recovery.mjs';
import { createManagedSecretPolicy } from './production-launch-policy-managed-secrets.mjs';
import {
  validateProductionTargetPolicy,
  validateProviderBillingPolicy,
  validateProviderConnectionPolicy,
} from './production-launch-policy-provider-billing.mjs';
import {
  validateApiBindPolicy,
  validatePublicIdentityLegalPolicy,
  validatePublicRuntimePolicy,
  validatePublicTransportPolicy,
} from './production-launch-policy-public-identity.mjs';
import {
  createErrorCollector,
  createPolicyContext,
  parseEnvFile,
} from './production-launch-policy-shared.mjs';

const envPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const verifyLocalSecretFiles = process.argv.includes('--verify-local-secret-files');

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-production-launch.mjs [runtime-env-file] [--verify-local-secret-files]');
  console.log('Validates the public SaaS launch environment, not disposable CI smoke values.');
  process.exit(0);
}

const collector = createErrorCollector();
const env = envPath ? parseEnvFile(envPath, collector) : process.env;
const context = createPolicyContext(env, collector);
const managedSecrets = createManagedSecretPolicy(context, {
  repoLocalSecretsRoot: resolve(import.meta.dirname, '..', 'secrets'),
  verifyLocalSecretFiles,
});

const { domain } = validatePublicIdentityLegalPolicy(context);
validateProductionTargetPolicy(context);
validatePublicTransportPolicy(context);
managedSecrets.validateSecretValues();
validateProviderConnectionPolicy(context);
const composeSecretFiles = managedSecrets.collectComposeSecretFiles();
validateApiBindPolicy(context);
const pitrCredentialFiles = validateBackupPitrPolicy(context, managedSecrets);
managedSecrets.validateIsolation([
  ...composeSecretFiles,
  ...pitrCredentialFiles,
]);
validateRecoveryEvidencePolicy(context, domain);
validateProviderBillingPolicy(context);
validatePublicRuntimePolicy(context, domain);

if (collector.errors.length > 0) {
  console.error(`Production launch validation failed (${collector.errors.length} issue${collector.errors.length === 1 ? '' : 's'}):`);
  for (const error of collector.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  source: envPath ? resolve(envPath) : 'process.env',
  checked: [...new Set(collector.checked)].sort(),
}, null, 2));
