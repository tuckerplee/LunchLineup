#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const METER_ID_PATTERN = /^mtr_[A-Za-z0-9]{8,}$/;
const EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const WEBHOOK_ENDPOINT_ID_PATTERN = /^we_[A-Za-z0-9]{8,}$/;
const EVENT_DESTINATION_ID_PATTERN = /^ed_(?:live_)?[A-Za-z0-9_]{8,}$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]{12,}$/;
export const REQUIRED_STRIPE_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.finalization_failed',
]);
export const REQUIRED_STRIPE_METER_ERROR_EVENTS = Object.freeze([
  'v1.billing.meter.error_report_triggered',
  'v1.billing.meter.no_meter_found',
]);

function requireString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseRuntimeEnv(contents) {
  const parsed = {};
  for (const [index, rawLine] of String(contents).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator === -1) throw new Error(`Invalid env line ${index + 1}: expected KEY=value.`);

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`Invalid env key on line ${index + 1}: ${key}`);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function assertLaunchProofBinding(launchProof, expected) {
  const evidence = launchProof?.evidence?.stripeMeter;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('launchProof.evidence.stripeMeter is required.');
  }

  const bindings = [
    ['sourceSha', expected.sourceSha],
    ['meterId', expected.meterId],
    ['eventName', expected.eventName],
    ['aggregation', expected.aggregation],
    ['livemode', expected.livemode],
    ['meterStatus', expected.meterStatus],
    ['customerPayloadKey', expected.customerPayloadKey],
    ['valuePayloadKey', expected.valuePayloadKey],
    ['webhookEndpointId', expected.webhookEndpointId],
    ['webhookUrl', expected.webhookUrl],
    ['webhookEvents', expected.webhookEvents],
    ['meterErrorEventDestinationId', expected.meterErrorEventDestinationId],
    ['meterErrorWebhookUrl', expected.meterErrorWebhookUrl],
    ['meterErrorEvents', expected.meterErrorEvents],
    ['priceIds', expected.priceIds],
  ];
  for (const [field, expectedValue] of bindings) {
    if (JSON.stringify(evidence[field]) !== JSON.stringify(expectedValue)) {
      throw new Error(`launchProof.evidence.stripeMeter.${field} must equal the live Stripe meter value.`);
    }
  }
  if (evidence.status !== 'passed') {
    throw new Error('launchProof.evidence.stripeMeter.status must be passed.');
  }
}

export async function verifyStripeMeterConfiguration({
  stripeSecretKey,
  meterId,
  eventName,
  webhookEndpointId,
  meterErrorEventDestinationId,
  appOrigin,
  priceIds,
  sourceSha,
  launchProof,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = 'https://api.stripe.com',
}) {
  const secretKey = requireString(stripeSecretKey, 'STRIPE_SECRET_KEY');
  const expectedMeterId = requireString(meterId, 'STRIPE_METER_ID');
  const expectedEventName = requireString(eventName, 'STRIPE_METER_EVENT_NAME');
  const expectedWebhookEndpointId = requireString(webhookEndpointId, 'STRIPE_WEBHOOK_ENDPOINT_ID');
  const expectedWebhookUrl = `${requireString(appOrigin, 'APP_ORIGIN')}/api/v1/billing/webhook`;
  const expectedMeterErrorDestinationId = requireString(
    meterErrorEventDestinationId,
    'STRIPE_METER_ERROR_EVENT_DESTINATION_ID',
  );
  const expectedMeterErrorWebhookUrl = `${requireString(appOrigin, 'APP_ORIGIN')}/api/v1/billing/meter-errors/webhook`;
  const expectedPriceIds = [...new Set((priceIds ?? []).map((value) => requireString(value, 'Stripe price ID')))].sort();
  const expectedSourceSha = requireString(sourceSha, 'sourceSha');

  if (!/^sk_live_[A-Za-z0-9]{24,}$/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a live Stripe secret key.');
  }
  if (!METER_ID_PATTERN.test(expectedMeterId)) {
    throw new Error('STRIPE_METER_ID must be a configured Stripe billing meter ID.');
  }
  if (!EVENT_NAME_PATTERN.test(expectedEventName)) {
    throw new Error('STRIPE_METER_EVENT_NAME must be a configured Stripe meter event name.');
  }
  if (!WEBHOOK_ENDPOINT_ID_PATTERN.test(expectedWebhookEndpointId)) {
    throw new Error('STRIPE_WEBHOOK_ENDPOINT_ID must be a configured Stripe webhook endpoint ID.');
  }
  if (!EVENT_DESTINATION_ID_PATTERN.test(expectedMeterErrorDestinationId)) {
    throw new Error('STRIPE_METER_ERROR_EVENT_DESTINATION_ID must be a configured Stripe event destination ID.');
  }
  if (expectedPriceIds.length === 0 || expectedPriceIds.some((priceId) => !PRICE_ID_PATTERN.test(priceId))) {
    throw new Error('Configured Stripe plan price IDs must be valid price IDs.');
  }
  if (!/^[a-f0-9]{40}$/i.test(expectedSourceSha)) {
    throw new Error('sourceSha must be a 40-character Git commit SHA.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Stripe meter verification requires an HTTP fetch implementation.');
  }

  async function retrieveStripeObject(path, label, extraHeaders = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, apiBaseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: 'application/json',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new Error(`Unable to retrieve the configured Stripe ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
      throw new Error(`Stripe rejected the configured ${label} lookup${status}.`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Stripe ${label} response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const meter = await retrieveStripeObject(`/v1/billing/meters/${encodeURIComponent(expectedMeterId)}`, 'meter');

  if (!meter || typeof meter !== 'object' || Array.isArray(meter)) {
    throw new Error('Stripe meter response must be an object.');
  }
  if (meter.id !== expectedMeterId || meter.object !== 'billing.meter') {
    throw new Error('Stripe returned a different billing meter identity than STRIPE_METER_ID.');
  }
  if (meter.event_name !== expectedEventName) {
    throw new Error('Stripe meter event_name does not match STRIPE_METER_EVENT_NAME.');
  }
  if (meter.default_aggregation?.formula !== 'last') {
    throw new Error('Stripe meter default_aggregation.formula must be last for daily active-seat snapshots.');
  }
  if (meter.livemode !== true) {
    throw new Error('Stripe meter must be a live-mode meter.');
  }
  if (meter.status !== 'active') {
    throw new Error('Stripe meter must be active.');
  }
  if (meter.customer_mapping?.type !== 'by_id'
      || meter.customer_mapping?.event_payload_key !== 'stripe_customer_id') {
    throw new Error('Stripe meter customer mapping must use payload key stripe_customer_id.');
  }
  if (meter.value_settings?.event_payload_key !== 'value') {
    throw new Error('Stripe meter value mapping must use payload key value.');
  }

  for (const priceId of expectedPriceIds) {
    const price = await retrieveStripeObject(`/v1/prices/${encodeURIComponent(priceId)}`, `price ${priceId}`);
    if (price?.id !== priceId || price?.object !== 'price' || price.active !== true || price.livemode !== true) {
      throw new Error(`Stripe price ${priceId} must be an active live-mode price.`);
    }
    if (price.type !== 'recurring' || price.recurring?.usage_type !== 'metered' || price.recurring?.meter !== expectedMeterId) {
      throw new Error(`Stripe price ${priceId} must be a recurring metered price attached to STRIPE_METER_ID.`);
    }
  }

  const webhook = await retrieveStripeObject(
    `/v1/webhook_endpoints/${encodeURIComponent(expectedWebhookEndpointId)}`,
    'webhook endpoint',
  );
  if (webhook?.id !== expectedWebhookEndpointId || webhook?.object !== 'webhook_endpoint'
      || webhook.status !== 'enabled' || webhook.livemode !== true) {
    throw new Error('Stripe webhook endpoint must be enabled and live mode.');
  }
  if (webhook.url !== expectedWebhookUrl) {
    throw new Error(`Stripe webhook endpoint URL must exactly match ${expectedWebhookUrl}.`);
  }
  const enabledEvents = Array.isArray(webhook.enabled_events) ? webhook.enabled_events : [];
  const hasWildcard = enabledEvents.includes('*');
  const missingEvents = hasWildcard
    ? []
    : REQUIRED_STRIPE_WEBHOOK_EVENTS.filter((eventType) => !enabledEvents.includes(eventType));
  if (missingEvents.length > 0) {
    throw new Error(`Stripe webhook endpoint is missing required events: ${missingEvents.join(', ')}.`);
  }

  const meterErrorDestination = await retrieveStripeObject(
    `/v2/core/event_destinations/${encodeURIComponent(expectedMeterErrorDestinationId)}?include[0]=webhook_endpoint.url`,
    'meter error event destination',
    { 'Stripe-Version': '2026-01-28.preview' },
  );
  if (meterErrorDestination?.id !== expectedMeterErrorDestinationId
      || meterErrorDestination?.object !== 'v2.core.event_destination'
      || meterErrorDestination.status !== 'enabled'
      || meterErrorDestination.livemode !== true
      || meterErrorDestination.type !== 'webhook_endpoint'
      || meterErrorDestination.event_payload !== 'thin') {
    throw new Error('Stripe meter error event destination must be an enabled live-mode thin webhook destination.');
  }
  if (meterErrorDestination.webhook_endpoint?.url !== expectedMeterErrorWebhookUrl) {
    throw new Error(`Stripe meter error webhook URL must exactly match ${expectedMeterErrorWebhookUrl}.`);
  }
  const meterErrorEvents = Array.isArray(meterErrorDestination.enabled_events)
    ? meterErrorDestination.enabled_events
    : [];
  const missingMeterErrorEvents = REQUIRED_STRIPE_METER_ERROR_EVENTS.filter(
    (eventType) => !meterErrorEvents.includes(eventType),
  );
  if (missingMeterErrorEvents.length > 0) {
    throw new Error(`Stripe meter error destination is missing required events: ${missingMeterErrorEvents.join(', ')}.`);
  }

  const verified = {
    sourceSha: expectedSourceSha,
    meterId: meter.id,
    eventName: meter.event_name,
    aggregation: meter.default_aggregation.formula,
    livemode: meter.livemode,
    meterStatus: meter.status,
    customerPayloadKey: meter.customer_mapping.event_payload_key,
    valuePayloadKey: meter.value_settings.event_payload_key,
    webhookEndpointId: webhook.id,
    webhookUrl: webhook.url,
    webhookEvents: hasWildcard ? ['*'] : [...REQUIRED_STRIPE_WEBHOOK_EVENTS],
    meterErrorEventDestinationId: meterErrorDestination.id,
    meterErrorWebhookUrl: meterErrorDestination.webhook_endpoint.url,
    meterErrorEvents: [...REQUIRED_STRIPE_METER_ERROR_EVENTS],
    priceIds: expectedPriceIds,
  };
  assertLaunchProofBinding(launchProof, verified);

  return { ok: true, stripeMeter: verified };
}

function usage() {
  console.log(
    'Usage: node scripts/verify-stripe-meter-config.mjs <runtime-env-file> <launch-proof-file> --source-sha <40-character-sha>',
  );
}

async function main(argv) {
  if (argv.includes('--help')) {
    usage();
    return;
  }

  const [runtimeEnvPath, launchProofPath] = argv;
  const sourceShaIndex = argv.indexOf('--source-sha');
  const sourceSha = sourceShaIndex >= 0 ? argv[sourceShaIndex + 1] : undefined;
  if (!runtimeEnvPath || !launchProofPath || !sourceSha) {
    usage();
    throw new Error('Runtime env, launch proof, and --source-sha are required.');
  }

  let env;
  try {
    env = parseRuntimeEnv(readFileSync(resolve(runtimeEnvPath), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read runtime env ${runtimeEnvPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const launchProof = parseJsonFile(launchProofPath, 'launch proof');
  const result = await verifyStripeMeterConfiguration({
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    meterId: env.STRIPE_METER_ID,
    eventName: env.STRIPE_METER_EVENT_NAME,
    webhookEndpointId: env.STRIPE_WEBHOOK_ENDPOINT_ID,
    meterErrorEventDestinationId: env.STRIPE_METER_ERROR_EVENT_DESTINATION_ID,
    appOrigin: env.APP_ORIGIN,
    priceIds: [env.STRIPE_PRICE_STARTER, env.STRIPE_PRICE_GROWTH, env.STRIPE_PRICE_ENTERPRISE],
    sourceSha,
    launchProof,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Stripe meter verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
