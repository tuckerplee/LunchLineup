#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createErrorCollector,
  parseEnvFile,
} from './production-launch-policy-shared.mjs';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function verifyResendReadiness({
  env,
  fetchImpl = globalThis.fetch,
  probeId = randomUUID(),
  dryRun = false,
} = {}) {
  if (!env || typeof env !== 'object') throw new Error('runtime_env_required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');

  const apiKey = required(env, 'RESEND_API_KEY');
  if (!/^re_[A-Za-z0-9_-]{24,}$/.test(apiKey) || /^re_(?:dev|test)_/i.test(apiKey)) {
    throw new Error('resend_api_key_not_live');
  }
  const webhookSecret = required(env, 'RESEND_WEBHOOK_SECRET');
  if (!/^whsec_[A-Za-z0-9_-]{24,}$/.test(webhookSecret) || /^whsec_(?:dev|test)_/i.test(webhookSecret)) {
    throw new Error('resend_webhook_secret_invalid');
  }
  const from = required(env, 'EMAIL_FROM');
  const senderDomain = emailAddress(from, 'email_from_invalid').split('@')[1].toLowerCase();
  if (!isPublicMailDomain(senderDomain)) throw new Error('email_from_invalid');
  const recipient = emailAddress(required(env, 'RESEND_PREFLIGHT_RECIPIENT'), 'preflight_recipient_invalid');
  if (!isPublicMailDomain(recipient.split('@')[1])) throw new Error('preflight_recipient_invalid');
  const sourceSha = required(env, 'DEPLOY_RELEASE_SHA').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('deploy_release_sha_invalid');
  const boundedProbeId = probeIdentity(probeId);
  const timeoutMs = boundedInteger(
    env.RESEND_PREFLIGHT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    30_000,
    'resend_preflight_timeout_invalid',
  );

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      sent: false,
      senderDomain,
      releaseSha: sourceSha,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('provider_timeout')), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `email-readiness/${sourceSha}/${boundedProbeId}`,
        },
        body: JSON.stringify({
          from,
          to: [recipient],
          subject: 'LunchLineup email readiness check',
          html: `<p>Transactional email readiness passed for release <code>${sourceSha}</code>.</p>`,
          text: `Transactional email readiness passed for release ${sourceSha}.`,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('provider_timeout');
      throw new Error(`provider_request_failed_${safeErrorClass(error)}`);
    }

    if (!response || typeof response.status !== 'number') {
      throw new Error('provider_response_invalid');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`provider_rejected_status_${boundedStatus(response.status)}`);
    }
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('provider_response_oversized');
    }
    let raw;
    try {
      raw = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('provider_timeout');
      throw new Error(`provider_response_read_failed_${safeErrorClass(error)}`);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('provider_response_oversized');
    }
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error('provider_response_invalid');
    }
    if (!result || typeof result.id !== 'string' || result.id.length < 1 || result.id.length > 255) {
      throw new Error('provider_response_invalid');
    }

    return {
      ok: true,
      endpoint: RESEND_EMAIL_ENDPOINT,
      senderDomain,
      releaseSha: sourceSha,
      providerAccepted: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  if (/\r|\n/.test(value)) throw new Error(`${name.toLowerCase()}_invalid`);
  return value;
}

function emailAddress(value, errorCode) {
  const match = value.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
  const address = match?.[1] ?? match?.[2];
  if (!address || address.length > 320) throw new Error(errorCode);
  return address;
}

function isPublicMailDomain(value) {
  const domain = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    return false;
  }
  return !(
    domain === 'example.com'
    || domain === 'example.net'
    || domain === 'example.org'
    || domain.endsWith('.example.com')
    || domain.endsWith('.example.net')
    || domain.endsWith('.example.org')
    || domain.endsWith('.test')
    || domain.endsWith('.invalid')
    || domain.endsWith('.localhost')
  );
}

function boundedInteger(value, fallback, minimum, maximum, errorCode) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(errorCode);
  }
  return parsed;
}

function probeIdentity(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(normalized)) {
    throw new Error('preflight_probe_id_invalid');
  }
  return normalized;
}

function safeErrorClass(error) {
  if (!(error instanceof Error)) return 'non_error';
  const name = String(error.constructor?.name ?? 'error').toLowerCase();
  return ['aborterror', 'error', 'typeerror'].includes(name) ? name : 'error';
}

function boundedStatus(status) {
  const parsed = Number(status);
  return Number.isInteger(parsed) && parsed >= 400 && parsed <= 599 ? parsed : 'unknown';
}

function parseArguments(argv) {
  const parsed = { envPath: null, to: null, releaseSha: null, checkOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') parsed.help = true;
    else if (argument === '--check-only') parsed.checkOnly = true;
    else if (argument === '--to' || argument === '--release-sha') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('argument_value_required');
      parsed[argument === '--to' ? 'to' : 'releaseSha'] = value;
      index += 1;
    } else if (argument.startsWith('--')) throw new Error('unknown_argument');
    else if (!parsed.envPath) parsed.envPath = argument;
    else throw new Error('unexpected_argument');
  }
  return parsed;
}

function currentGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/verify-resend-readiness.mjs [runtime-env-file] [--to <recipient>] [--release-sha <sha>] [--check-only]');
    console.log('Validates RESEND_API_KEY, RESEND_WEBHOOK_SECRET, EMAIL_FROM and the recipient, then sends ONE idempotent test email.');
    console.log('  --to            recipient (overrides RESEND_PREFLIGHT_RECIPIENT); must be an address the owner controls');
    console.log('  --release-sha   40-hex release id for the idempotency key (defaults to DEPLOY_RELEASE_SHA, then git HEAD)');
    console.log('  --check-only    validate configuration and exit without calling Resend');
    return;
  }
  const collector = createErrorCollector();
  const baseEnv = args.envPath ? parseEnvFile(args.envPath, collector) : process.env;
  if (collector.errors.length > 0) throw new Error('runtime_env_invalid');
  const env = { ...baseEnv };
  if (args.to) env.RESEND_PREFLIGHT_RECIPIENT = args.to;
  if (args.releaseSha) env.DEPLOY_RELEASE_SHA = args.releaseSha;
  if (!String(env.DEPLOY_RELEASE_SHA ?? '').trim()) env.DEPLOY_RELEASE_SHA = currentGitSha();
  const result = await verifyResendReadiness({ env, dryRun: args.checkOnly });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'unexpected_error';
    console.error(`Resend readiness preflight failed reason=${reason}`);
    process.exitCode = 1;
  });
}
