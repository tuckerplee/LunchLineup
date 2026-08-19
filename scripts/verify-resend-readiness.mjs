#!/usr/bin/env node
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

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify-resend-readiness.mjs [runtime-env-file]');
    console.log('Sends one idempotent acceptance probe to RESEND_PREFLIGHT_RECIPIENT.');
    return;
  }
  const envPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  const collector = createErrorCollector();
  const env = envPath ? parseEnvFile(envPath, collector) : process.env;
  if (collector.errors.length > 0) throw new Error('runtime_env_invalid');
  const result = await verifyResendReadiness({ env });
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
