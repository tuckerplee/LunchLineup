import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyStripeMeterConfiguration } from '../../scripts/verify-stripe-meter-config.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const meterId = 'mtr_1234567890abcdef';
const eventName = 'll.active_staff';
const secretKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
const webhookEndpointId = 'we_1234567890abcdef';
const meterErrorEventDestinationId = 'ed_live_1234567890abcdef';
const appOrigin = 'https://app.lunchlineup.test';
const webhookUrl = `${appOrigin}/api/v1/billing/webhook`;
const meterErrorWebhookUrl = `${appOrigin}/api/v1/billing/meter-errors/webhook`;
const priceIds = ['price_enterprise1234567890', 'price_growth1234567890', 'price_starter1234567890'];
const webhookEvents = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.finalization_failed',
];
const meterErrorEvents = [
  'v1.billing.meter.error_report_triggered',
  'v1.billing.meter.no_meter_found',
];

function launchProof(overrides = {}) {
  return {
    version: 1,
    sourceSha,
    evidence: {
      stripeMeter: {
        status: 'passed',
        sourceSha,
        meterId,
        eventName,
        aggregation: 'last',
        livemode: true,
        meterStatus: 'active',
        customerPayloadKey: 'stripe_customer_id',
        valuePayloadKey: 'value',
        webhookEndpointId,
        webhookUrl,
        webhookEvents,
        meterErrorEventDestinationId,
        meterErrorWebhookUrl,
        meterErrorEvents,
        priceIds,
        ...overrides,
      },
    },
  };
}

function stripeResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: meterId,
        object: 'billing.meter',
        event_name: eventName,
        default_aggregation: { formula: 'last' },
        livemode: true,
        status: 'active',
        customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
        value_settings: { event_payload_key: 'value' },
        ...overrides,
      };
    },
  };
}

function fetchStripe({ meter = stripeResponse(), priceOverrides = {}, webhookOverrides = {} } = {}) {
  return async (url) => {
    if (url.pathname.includes('/billing/meters/')) return meter;
    if (url.pathname.includes('/prices/')) {
      const id = url.pathname.split('/').at(-1);
      return stripeResponse({
        id,
        object: 'price',
        active: true,
        type: 'recurring',
        recurring: { usage_type: 'metered', meter: meterId },
        ...priceOverrides,
      });
    }
    if (url.pathname.includes('/v2/core/event_destinations/')) {
      return stripeResponse({
        id: meterErrorEventDestinationId,
        object: 'v2.core.event_destination',
        status: 'enabled',
        livemode: true,
        type: 'webhook_endpoint',
        event_payload: 'thin',
        enabled_events: meterErrorEvents,
        webhook_endpoint: { url: meterErrorWebhookUrl },
      });
    }
    return stripeResponse({
      id: webhookEndpointId,
      object: 'webhook_endpoint',
      status: 'enabled',
      url: webhookUrl,
      enabled_events: webhookEvents,
      ...webhookOverrides,
    });
  };
}

function verify({ response = stripeResponse(), proof = launchProof(), fetchImpl } = {}) {
  return verifyStripeMeterConfiguration({
    stripeSecretKey: secretKey,
    meterId,
    eventName,
    webhookEndpointId,
    meterErrorEventDestinationId,
    appOrigin,
    priceIds,
    sourceSha,
    launchProof: proof,
    fetchImpl: fetchImpl ?? fetchStripe({ meter: response }),
  });
}

test('authoritatively verifies and binds the live last-aggregation Stripe meter', async () => {
  const requests = [];
  const result = await verifyStripeMeterConfiguration({
    stripeSecretKey: secretKey,
    meterId,
    eventName,
    webhookEndpointId,
    meterErrorEventDestinationId,
    appOrigin,
    priceIds,
    sourceSha,
    launchProof: launchProof(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return fetchStripe()(url);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.stripeMeter, {
    sourceSha,
    meterId,
    eventName,
    aggregation: 'last',
    livemode: true,
    meterStatus: 'active',
    customerPayloadKey: 'stripe_customer_id',
    valuePayloadKey: 'value',
    webhookEndpointId,
    webhookUrl,
    webhookEvents,
    meterErrorEventDestinationId,
    meterErrorWebhookUrl,
    meterErrorEvents,
    priceIds,
  });
  assert.equal(requests[0].url.href, `https://api.stripe.com/v1/billing/meters/${meterId}`);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${secretKey}`);
  assert.equal(requests.length, 6);
});

test('fails closed when Stripe reports a non-last aggregation', async () => {
  await assert.rejects(
    verify({ response: stripeResponse({ default_aggregation: { formula: 'sum' } }) }),
    /default_aggregation\.formula must be last/,
  );
});

test('fails closed on a different event name, inactive meter, or Stripe API failure', async () => {
  await assert.rejects(verify({ response: stripeResponse({ event_name: 'other.event' }) }), /event_name does not match/);
  await assert.rejects(verify({ response: stripeResponse({ status: 'inactive' }) }), /must be active/);
  await assert.rejects(verify({ response: { ok: false, status: 401 } }), /HTTP 401/);
});

test('fails closed on incompatible meter mappings, plan prices, or webhook subscriptions', async () => {
  await assert.rejects(
    verify({ response: stripeResponse({ customer_mapping: { type: 'by_id', event_payload_key: 'customer' } }) }),
    /customer mapping/,
  );
  await assert.rejects(
    verify({ fetchImpl: fetchStripe({ priceOverrides: { recurring: { usage_type: 'licensed', meter: meterId } } }) }),
    /recurring metered price/,
  );
  await assert.rejects(
    verify({ fetchImpl: fetchStripe({ webhookOverrides: { enabled_events: ['invoice.paid'] } }) }),
    /missing required events/,
  );
});

test('fails closed when the live webhook URL has the wrong host or path', async () => {
  await assert.rejects(
    verify({ fetchImpl: fetchStripe({ webhookOverrides: { url: 'https://wrong.example/api/v1/billing/webhook' } }) }),
    /URL must exactly match/,
  );
  await assert.rejects(
    verify({ fetchImpl: fetchStripe({ webhookOverrides: { url: `${appOrigin}/api/v1/webhook` } }) }),
    /URL must exactly match/,
  );
});

test('fails closed when the meter error destination is missing events or has the wrong URL', async () => {
  const baseFetch = fetchStripe();
  await assert.rejects(verify({
    fetchImpl: async (url, options) => url.pathname.includes('/v2/core/event_destinations/')
      ? stripeResponse({
          id: meterErrorEventDestinationId,
          object: 'v2.core.event_destination',
          status: 'enabled',
          livemode: true,
          type: 'webhook_endpoint',
          event_payload: 'thin',
          enabled_events: ['v1.billing.meter.error_report_triggered'],
          webhook_endpoint: { url: meterErrorWebhookUrl },
        })
      : baseFetch(url, options),
  }), /missing required events/);
  await assert.rejects(verify({
    fetchImpl: async (url, options) => url.pathname.includes('/v2/core/event_destinations/')
      ? stripeResponse({
          id: meterErrorEventDestinationId,
          object: 'v2.core.event_destination',
          status: 'enabled',
          livemode: true,
          type: 'webhook_endpoint',
          event_payload: 'thin',
          enabled_events: meterErrorEvents,
          webhook_endpoint: { url: `${appOrigin}/wrong` },
        })
      : baseFetch(url, options),
  }), /meter error webhook URL must exactly match/);
});

test('requires launch proof to match the live meter identity and aggregation', async () => {
  await assert.rejects(verify({ proof: launchProof({ meterId: 'mtr_abcdef1234567890' }) }), /meterId must equal/);
  await assert.rejects(verify({ proof: launchProof({ aggregation: 'sum' }) }), /aggregation must equal/);
  await assert.rejects(verify({ proof: launchProof({ webhookUrl: `${appOrigin}/wrong` }) }), /webhookUrl must equal/);
  await assert.rejects(verify({ proof: launchProof({ meterErrorWebhookUrl: `${appOrigin}/wrong` }) }), /meterErrorWebhookUrl must equal/);
  await assert.rejects(verify({ proof: { version: 1, sourceSha, evidence: {} } }), /stripeMeter is required/);
});

test('production workflow performs live Stripe verification before deploy mutation', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const stripeGate = ci.indexOf('Verify live Stripe meter configuration');
  const deployMutation = ci.indexOf('name: "17. Blue/Green deploy"');

  assert.notEqual(stripeGate, -1);
  assert.notEqual(deployMutation, -1);
  assert.ok(stripeGate < deployMutation);
  assert.match(
    ci,
    /node scripts\/verify-stripe-meter-config\.mjs "\$PRODUCTION_RUNTIME_ENV_PATH" "\$launch_proof" --source-sha "\$GITHUB_SHA"/,
  );
});
