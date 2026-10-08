# Provider inputs and acceptance contracts

Source reconciliation: 8 October 2026, base `48a80e3b8c8c7990f340eeebd1ed36e6e587c9f1`.
This register covers C10 email, OIDC, signup challenge, payroll handoff, tenant
webhooks and storage dependencies. Stripe inputs are listed in [billing provider contracts](billing-provider-contracts.md). It records
missing qualification inputs, not an assertion that a deployed setting is absent.
No provider access, email send, provider mutation, runtime installation or test
execution was performed for this register. Signup remains `closed_beta` in both
API and web. Production activation is separately deferred.

## Input custody and authorization

The owner must provide **references and versions**, never values in chat, Git,
logs or evidence. Reliability owns runtime delivery. For isolated qualification,
the owner must designate an absolute, access-restricted runtime env path outside
the checkout; the exact sandbox path/reference is still pending. Pass that path
through the admitted runner's existing environment contract. A production secret
reference is not sandbox authorization. The future production contract uses
`PRODUCTION_RUNTIME_SECRET_REFERENCE` and `PRODUCTION_RUNTIME_SECRET_VERSION`,
materializes a private temporary env file and binds `COMPOSE_SERVICE_ENV_FILE` to
it. This document does not authorize using the historical production deployment
commands or installing configuration.

For every provider, record the responsible person, provider account/environment,
allowed identities/recipients/resources/actions, a time-bound authorization,
non-secret configuration version, and cleanup owner. Preserve provider-issued
IDs only when safe; keep customer records, mailbox contents, credentials and
signature headers in protected evidence. Permission to inspect source does not
permit readiness probes: `verify-resend-readiness.mjs` sends an email.

| Input needed | Exact settings / destination | Purpose and missing owner evidence |
| --- | --- | --- |
| Resend sender and authorized recipients | API/worker private runtime env: `RESEND_API_KEY`, `EMAIL_FROM`, `APP_ORIGIN`; API `RESEND_WEBHOOK_SECRET`; approved runner `RESEND_PREFLIGHT_RECIPIENT`, `RESEND_PREFLIGHT_TIMEOUT_MS`, `DEPLOY_RELEASE_SHA` | Provider account, verified sender/domain, authorized mailbox and approved send count/action. Configure signed callback at `/api/webhooks/resend/delivery-events`; never a retired `/api/v1/*` URL. Need actual inbox and provider event readback. |
| Email envelope keys and delivery enablement | Private runtime env: `PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY`, `STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY`, `PASSWORD_RESET_EMAIL_OUTBOX_ENABLED`, `STAFF_INVITATION_OUTBOX_ENABLED`, `STAFF_INVITATION_MAX_ATTEMPTS`; API `SCHEDULE_PUBLISHED_EMAIL_ENABLED`, `SCHEDULE_PUBLISHED_EMAIL_PROVIDER_TIMEOUT_MS`; API optional `EMAIL_OTP_DELIVERY_DEADLINE_MS` | Distinct exact 32-byte hex/base64 outbox keys; delivery prerequisites shared with worker owner. Enablement is an authorized runtime decision. OTP deadline accepts 100–30000 ms (default 10000); inspect candidate worker configuration for its retry/lease settings. No queue rewrite required. |
| OIDC issuer, client and supported endpoint contract | API private runtime env: `OIDC_ENABLED`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`; web build `NEXT_PUBLIC_OIDC_ENABLED` | Owner must name supported issuer, approved client, exact HTTPS callback `/api/v2/auth/callback`, allowed tenant/users, scope and provider endpoint contract. Local `.env.example` uses localhost with the same v2 route. No enabled issuer has been qualified. Keep disabled until an accepted contract and isolated evidence exist. |
| Conditional signup challenge | API private runtime env `TURNSTILE_SECRET_KEY`; web build `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; preserve `PUBLIC_SIGNUP_MODE=closed_beta`, `NEXT_PUBLIC_SIGNUP_MODE=closed_beta` | Need provider site/domain ownership and challenge configuration. Closed beta denies public signup before the challenge exchange. An open-signup exercise additionally requires separate counsel-approved versioned Terms and policy authorization; it is not authorized by receipt of a Turnstile key. |
| Tenant outbound webhook receiver | API private runtime env `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT`, optional distinct `WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS`, `WEBHOOK_MAX_PAYLOAD_BYTES`, `WEBHOOK_INITIAL_DELIVERY_LEASE_MS`; tenant endpoint URL/signing secret via authorized endpoint API, encrypted in database | Need approved controlled HTTPS receiver, tenant, event types, signer/receiver secret custody and response-loss/replay actions. Encryption keys decode to 32 bytes. Signing secret is tenant endpoint data, not a fabricated global env setting. |
| Payroll provider handoff | No payroll-provider API-key setting exists in the reviewed export path. Use protected owner-approved recipient/import portal and the authorized export/reconciliation application flow. | Need supported provider/version, required CSV mapping, authorized synthetic payroll identities, recipient, import acknowledgment and rejection/duplicate semantics. Existing immutable CSV export is the contract; do not invent an automatic provider adapter or claim certification. |
| Logical-backup object storage | Runtime env `BACKUP_OFFSITE_URI`, `BACKUP_OFFSITE_RETENTION_DAYS`, `BACKUP_OFFSITE_CREDENTIALS_DIR`, `BACKUP_ENCRYPTION_KEY_SECRET_FILE`; credential mount `/run/secrets/backup-offsite/aws-credentials`, `/run/secrets/backup-offsite/aws-config`; encryption `/run/secrets/backup_key` | Reliability consumer. Need isolated versioned/Object-Locked bucket and non-root prefix, exact version readback, approved immutable retention/lifecycle, independently managed writer/restore identities and delete-denial proof. Protected host example: `/etc/lunchlineup/backup-offsite`, root-owned 0750 directory and 0640 credential files. No production credentials or installation authorized. |
| PITR object storage | Runtime env `PITR_ENABLED`, `PITR_S3_ENDPOINT`, `PITR_S3_BUCKET`, `PITR_S3_PREFIX`, `PITR_OBJECT_LOCK_RETENTION_DAYS`, `PITR_LIFECYCLE_MAX_RETENTION_DAYS`, `PITR_LIFECYCLE_POLICY_PROOF_FILE`, `PITR_LIFECYCLE_POLICY_PROOF_URI`, `PITR_LIFECYCLE_POLICY_SHA256` | Need dedicated cluster prefix, provider compatibility, Object Lock/versioning/lifecycle readback and independent approved retention. Reliability owns scripts/consumers and drills; configuration alone proves neither recovery nor custody. |
| PITR separated credentials | Absolute protected host directories named by `PITR_WAL_OBJECT_STORE_SECRETS_DIR`, `PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR`, `PITR_RESTORE_OBJECT_STORE_SECRETS_DIR`, `PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR`; each mounts its respective `/run/secrets/pitr-{wal,base-backup,restore,lifecycle-audit}-object-store/{access_key,secret_key}` | Consumer variables are `PITR_ACCESS_KEY_FILE` and `PITR_SECRET_KEY_FILE`. Need separate append-only writer, read-only restore and lifecycle-inspection identities. Lifecycle administration remains external and must not be mounted in these consumers. |
| Export artifact custody | API runtime `TENANT_EXPORT_ARTIFACT_DIRECTORY`, `TENANT_EXPORT_SHARED_STORAGE`, `API_REPLICA_COUNT`; optional `TENANT_EXPORT_MAX_ARTIFACT_BYTES`, `TENANT_EXPORT_GLOBAL_QUOTA_BYTES`, `TENANT_EXPORT_PER_TENANT_QUOTA_BYTES` | Existing Compose mounts `tenant_export_artifacts` at `/var/lib/lunchlineup/tenant-exports`; this is a durable filesystem contract, not an application S3 adapter. Need approved volume/replica topology, access and erase evidence. Setting shared-storage=true alone does not prove cross-host shared custody. Identity owns lifecycle behavior; Privacy owns retention semantics. |

## Source and retained evidence reconciliation

| Action / boundary | Existing implementation and evidence | Remaining disposition |
| --- | --- | --- |
| `provider.emailOtp` | `apps/api/src/auth/email.service.ts` bounds synchronous handoff, checks suppression and logs no OTP. PR96/97 fixed tenant-slug and cookie defects; C00 is synthetic HTTP session evidence only. | Authorized inbox/provider exchange, expiry/consumption/session outcome still pending. Do not relabel local synthetic evidence. |
| Invitation / reset delivery, C07 dependency | `apps/worker/src/staff_invitation_outbox.py` uses `staff-invitation/<outbox-id>`; `password_reset_email.py` uses `password-reset/<outbox-id>`. PR93 lease fix: 31 local checks; PR94 retryable Resend409 fix: 24 local checks. Checkpoint records independent review and narrow limits. | Worker owns orchestration. Reuse unchanged local evidence; actual provider delivery, response-loss deduplication and durable native recovery remain pending. |
| `provider.resendDeliveryEvents` | Raw-body controller + SDK verification in `apps/api/src/email-delivery/email-delivery-feedback.{controller,service}.ts`; Caddy exact alias to private v1 handler. Permanent events monotonically suppress matching nondeleted recipients. | Provider signing configuration and exact ingress transport/DB evidence pending. Unknown/transient events do not establish successful delivery. |
| `provider.oidcSignIn` | Controller uses single-use Redis state plus browser correlation cookie; service checks verified email and tenant-scoped issuer/subject binding. Token/userinfo transport has timeout/body/redirect bounds. | Provider contract unresolved: source constructs `o/oauth2/auth`, `o/oauth2/token`, `o/oauth2/userinfo` beneath configured issuer; no discovery or ID-token validation is implemented. Correlation cookie nonce is not an ID-token nonce. Subject binding first uses verified email. Identity must disposition issuer/audience/nonce and first-binding semantics against approved provider. These observations are not a completed exploit or reason to fabricate discovery support. |
| `provider.signupChallenge` | `auth.service.ts` uses fixed Turnstile verification URL with response limit, timeout and redirects refused; requires `success === true`. Closed-beta admission precedes public signup challenge. | Current closed-beta denial can be qualified without enabling signup; separately authorized open mode and real provider readback remain pending. Nonproduction missing-key shortcut is not provider evidence. |
| `provider.tenantWebhookDelivery` | `webhooks.service.ts`, `webhook-delivery.crypto.ts`, `webhook-delivery.store.ts` implement encrypted durable payload/signing/retry identity; replay worker is Payroll-owned. | Approved receiver verification, failure/replay ledger readbacks and erasure evidence pending. No demonstrated adapter defect changed in this reconciliation. |
| `provider.payrollProviderHandoff` | PR104 native original export and PR105 positive/negative amendment proof establish local immutable CSV, signed snapshot bindings, credits/replay and reconciliation. Retained evidence: `/tmp/lunchlineup-native-payroll-y7x9h8a6`, `/tmp/lunchlineup-payroll-amendment-uidkct1a`. | Actual provider import/acceptance and independently matching totals/hash remain pending. Preserve local proof; do not rerun unchanged original/amendment cases just to claim provider success. |
| Durable storage, C09/C13 dependency | `infrastructure/postgres/pitr-object-store.sh`, Compose backup/PITR mounts, and `apps/api/src/admin/tenant-export.service.ts` define distinct storage contracts. PR98–103 cover repair/local logical recovery only. | Object version custody, permission denial, lifecycle and off-host/PITR recovery require approved inputs and Reliability execution. Temporary historical evidence must be preserved through the authorized evidence owner before release reliance. |

## Test Agent handoff

Implementation leads may run existing relevant checks; necessary testing additions
remain bounded and coordinated through the Test Agent. Bind each result
to the full candidate SHA, patch digest if not yet integrated, exact source file
hashes, approved configuration version and admitted target. Preserve the first
failure and failed-attempt artifacts. Synthetic SDK/provider fixtures are local
controls, never real provider delivery or acceptance.

- **Resend raw ingress:** exact `/api/webhooks/resend/delivery-events` alias,
  unmodified raw bytes, valid signature and missing/invalid signature, changed
  body, expired/future timestamp, missing API key/webhook secret, and DB failure.
  Invalid signatures return400; missing configuration503; processing failure
  must not acknowledge success. Verify hard/permanent bounce, complaint and
  suppression affect matching active recipients; soft bounce/unrelated event
  does not. Replay and older events must not replace newer suppression or send
  mail. Never record webhook signature headers or email payloads.
- **Email delivery:** approved recipient and sender only; suppression/inactive
  refusal, provider rejection/outage/timeout, response loss, and stable outbox
  idempotency keys. For password reset, retain distinction between retryable
  `concurrent_idempotent_requests`/`resource_locked`409 and permanent unknown or
  payload-mismatch409. Confirm one provider acceptance independently, no duplicate
  credentials, lease-loss safety, terminal payload erasure and no secret logs.
- **OIDC:** do not assume the example issuer supports constructed endpoints.
  First obtain provider contract disposition with Identity. Verify exact v2
  callback, disabled SSO, state/correlation mismatch, state expiry/replay, wrong
  issuer/subject/email binding, inactive tenant/user and outage. Assert no new
  session/account mutation on refusal. Record ID-token/nonce validation as an
  unresolved contract until implemented or explicitly approved otherwise.
- **Signup challenge:** closed-beta denial must prevent provider handoff and
  provisioning. In a separately approved challenge configuration, cover missing,
  oversized, invalid, expired and reused token, timeout/redirect/oversized body,
  missing secret and provider failure; confirm zero provisioning on denial.
- **Tenant webhook receiver:** verify lowercase hex HMAC-SHA256 over the exact
  UTF-8 string `v2:<deliveryId>:<eventType-or-empty>:<raw-body>` using the endpoint
  secret. Require `X-LunchLineup-Signature-Version: v2`, stable
  `X-LunchLineup-Delivery-Id` and matching optional `X-LunchLineup-Event`.
  Receiver must deduplicate authenticated delivery IDs durably; the contract has
  no timestamp freshness header. Reject modified body/event/ID/signature. Cover
  private-address/redirect denial, disabled endpoint/tenant, five-second timeout,
  response loss, replay/lease loss, exact single debit/settlement, terminal
  payload erasure and key rotation with retained previous key.
- **Payroll:** approved synthetic payroll CSV only; independently compare exact
  export hash/totals/source entries and provider acknowledgment, reject mismatched
  or unsupported imports, preserve locked history and unknown outcome when
  acceptance cannot be confirmed. Duplicate acceptance cannot rewrite history.
- **Storage:** Reliability supplies exact immutable object version and isolated
  identities; verify write/read/denied delete and bounded lifecycle without
  altering retained production data. For exports, verify artifact durability,
  authorized expiring download, cross-tenant refusal, cleanup and replica
  custody. A local filesystem export is not off-host S3/PITR evidence.

The storage owner also requires `PITR_AUTHORIZATION_SIMULATOR_FILE`, `PITR_AUTHORIZATION_SIMULATOR_SHA256`, and `PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS`, plus independently protected, non-symlink `DR_OFFHOST_FETCH_COMMAND` and `DR_OFFHOST_READBACK_COMMAND` adapters. Reliability owns these consumers; their presence is not proof of provider authorization, immutability or successful retrieval. Approved actual host destinations remain owner input.
