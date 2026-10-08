# Stripe provider contracts and pending inputs

Source reconciliation: 8 October 2026, base `48a80e3b8c8c7990f340eeebd1ed36e6e587c9f1`. Provider access and mutations remain unauthorized. Implementation leads may run existing relevant checks; necessary test or harness additions remain bounded and coordinated through the Test Agent.

## Existing implementation retained

StripeService already implements tenant-bound subscription checkout locking, customer recovery/idempotency and verified session/line-items; local feature matrix separated from live recovery calls; allowed price mapping and capacity; one managed plan item update with pending_if_incomplete/create_prorations; paused resume with payment remediation; durable cancellation/purge readback and compensation; signed raw-body webhook handling and durable billing audit/high-water cursor. Credit purchase owner independently retrieves authoritative session/line items, verifies metadata/customer/tenant/subscription, grants ledger settlement once, and tracks refund lifecycle. Meter-error owner verifies raw signature, retrieves authoritative event identity/type, checks production live mode/configured aggregate meter, bounds response/work, and rotates retry identity. Worker billing_usage.py already owns snapshot/lease/replay; no worker modifications.

Read handoff README and checkpoint-before-handoff.json. Their native session, payroll and domain results do not establish Stripe provider success; checkpoint has no dedicated billing/Stripe qualification result. Existing local specs are retained controls, not proof of current execution or real sandbox provider state. All C10 billing native/browser/durable/provider contracts remain unqualified unless Test Agent reconciles an applicable immutable result. No reason to rebuild working adapters from pending labels.

## Exact external-input register (values never in evidence)

Reliability owns final protected sandbox secret destination; requires approved absolute private runtime env file outside checkout/artifacts, mode 0600, admitted runner delivery into API/worker protected environments. Existing production contract names PRODUCTION_RUNTIME_SECRET_REFERENCE + PRODUCTION_RUNTIME_SECRET_VERSION (immutable AWS Secrets Manager version), decoded PRODUCTION_RUNTIME_ENV_PATH / COMPOSE_SERVICE_ENV_FILE; this is deferred, not permission to invoke historical GitHub/VM217 flows. Exact sandbox secret path remains owner input, not invented.

- STRIPE_SECRET_KEY: authorized sandbox account API credential; API and billing usage worker. Need account ownership, test-mode confirmation and allowed read/mutation scope.
- STRIPE_WEBHOOK_SECRET: snapshot billing callback signing secret; API only. STRIPE_WEBHOOK_ENDPOINT_ID: nonsecret approved endpoint identity for readback. Private route /v1/billing/webhook; use admitted external bridge mapping, not invented URL.
- STRIPE_METER_ERROR_WEBHOOK_SECRET: distinct thin-event signature secret; API. STRIPE_METER_ERROR_EVENT_DESTINATION_ID: destination identity. Private route /v1/billing/meter-errors/webhook.
- STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH, STRIPE_PRICE_ENTERPRISE: approved recurring plan IDs bound to sandbox account, currency/product/capacity policy; API.
- STRIPE_PRICE_CREDIT_PACK_100, STRIPE_PRICE_CREDIT_PACK_500, STRIPE_PRICE_CREDIT_PACK_2000: approved one-time credit pack IDs/amount/currency; API (Compose now forwards these settings; configured values and actual sandbox outcomes remain pending).
- STRIPE_BILLING_PORTAL_CONFIGURATION_ID: approved active configuration disabling subscription_update; API. Owner must review cancel behavior and explicitly authorize any automatic config creation (current fallback may create a configuration); no provider calls authorized here.
- STRIPE_METER_ID, STRIPE_METER_EVENT_NAME, STRIPE_METER_AGGREGATION=last: matching meter identity/event/payload mapping and last-value aggregation; API + worker. STRIPE_METERED_USAGE_ENABLED remains false until admitted proof/action authorization. Production live-meter proof deferred.
- APP_ORIGIN: approved HTTPS callback/checkout return origin; API and web agreement. Do not set PUBLIC_SIGNUP_MODE or web equivalent away from closed_beta.
- Owner must supply exact sandbox tenant/customer/subscription/test payer identities, permitted checkout/change/cancel/resume/refund/purge actions and upper limits; no real card/payment or production credentials. Credentials alone do not authorize mutations.

## Remaining required integration qualification

Exact /v2 billing routes and browser returns, current permission/session and cross-tenant refusals; authoritative checkout/customer/subscription readback; wallet unchanged before paid completion and exact one settlement after event/replay; credit refund failure/late retry; no false paid access from redirect/payment URL; allowed-price/capacity refusals; same-price no mutation; paused/nonpaused resume; cancellation period-end preservation, response loss/reconciliation/compensation; approved purge only with retained audit/legal-hold refusal.

Snapshot webhook: raw Buffer + stripe-signature, missing/wrong/expired signature and altered body refusal, missing secret503, duplicate/late audit/credit/entitlement invariants, provider retrieval/DB failure not acknowledged as success. Meter thin webhook: dedicated secret, authoritative ID/type/mode/configured meter, exact dual correlation, replay0, bounded aggregate samples/response/window/pagination, concurrent-update/outage failure, retry/dead-letter identity preservation. Usage: immutable tenant/metric/period snapshots, leased claims, last-value aggregation, lost-response idempotency and async error recovery; worker owner coordinates, Test Agent executes. Synthetic fixtures must be explicitly synthetic; actual provider success awaits authorization and independent state readbacks.

