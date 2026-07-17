# Outbound Delivery

## Scope

This runbook covers OTP, password-reset email, staff-invitation email, in-app notification outbox delivery, tenant webhook delivery/replay, Resend bounce and complaint feedback, terminal payload erasure, and operator recovery.

## Required Configuration

- API: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and `EMAIL_FROM`.
- Worker: `PASSWORD_RESET_EMAIL_OUTBOX_ENABLED=true`, `PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY`, canonical `STAFF_INVITATION_OUTBOX_ENABLED=true`, the dedicated `STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY`, shared `STAFF_INVITATION_MAX_ATTEMPTS`, canonical HTTPS `APP_ORIGIN`, `RESEND_API_KEY`, `EMAIL_FROM`, database URL, and platform-admin database capability.
- Configure Resend delivery feedback to POST signed events to `/api/v1/email-delivery/provider-events`. Subscribe to bounce, complaint, and suppression events.

Production startup and launch validation fail closed when the Resend API or webhook signing secret is missing or placeholder-shaped. Never log OTPs, reset URLs, webhook payloads, recipient addresses, encrypted payloads, or provider signature headers.

## Delivery Ownership

- OTP: API sends synchronously after checking the active recipient suppression state.
- Password reset: API writes an encrypted outbox envelope; the worker claims with a lease, checks recipient lifecycle/suppression, and sends with `password-reset/<outbox-id>` as the provider idempotency key.
- Staff invitation: API commits the user, role assignment, encrypted outbox envelope, and audit event atomically; the worker uses `staff-invitation/<outbox-id>` as the provider idempotency key after final recipient lifecycle/suppression checks. This access flow never consumes scheduling credits.
- Notifications: the API processor claims committed notification intents with skip-locked leases and bounded attempts.
- Tenant webhooks: the API replay worker owns durable encrypted delivery rows. `X-LunchLineup-Delivery-Id` remains stable across retries so consumers can deduplicate.
- Resend feedback: the API verifies the raw signed body before applying permanent suppression. Transient bounces do not suppress.

## Triage

1. Check notification metrics: `lunchlineup_notification_outbox_dead_lettered` must remain zero; use `lunchlineup_notification_outbox_total` by status to distinguish retries from terminal failures.
2. Check password-reset metrics: `lunchlineup_password_reset_email_sweep_ready`, `lunchlineup_password_reset_email_sweep_last_success_unixtime`, `lunchlineup_password_reset_email_dead_lettered`, and `lunchlineup_password_reset_email_total` by status.
3. Check staff-invitation readiness, last-success age/configured maximum, due rows, expired leases, recent provider failures, and dead letters in the platform dashboard.
4. Check webhook replay metrics and token-free logs for ready, in-flight, retrying, dead-lettered, and sweep-failure outcomes.
5. Query notification, password-reset, and staff-invitation outbox status counts using the restricted operator path. Do not select title, body, encrypted payload, token hash, endpoint secret, or recipient fields.
6. Confirm the Resend feedback endpoint returns 200 for valid signed events and 400 for invalid signatures. Repeated 503 responses mean `RESEND_WEBHOOK_SECRET` is absent from the API runtime.
7. Correlate only opaque outbox/delivery IDs. Do not paste payloads or recipients into tickets.

## Recovery

- `FAILED` rows retry automatically after `nextAttemptAt`; do not manually clone them.
- Expired `SENDING` leases are reclaimable. A lease-loss error after provider handoff must not overwrite the new owner state; use the stable provider idempotency key to investigate an ambiguous outcome.
- `DEAD_LETTERED` is terminal operator evidence. Resolve provider/configuration or recipient lifecycle causes, then create a fresh business action through the owning API instead of mutating attempts or restoring erased payloads. For staff invitations, call `POST /api/v1/users/<user-id>/invitation/reissue` with one bounded `Idempotency-Key`; the tenant-scoped Serializable transaction preserves the user, rotates to a fresh encrypted envelope and outbox/provider identity, and records the prior terminal ID/state in immutable audit history. Reuse the same key only after ambiguous response loss. If that reissued action later dead-letters, use a new key.
- A complaint, hard bounce, or provider suppression blocks future OTP and password-reset handoff for that active user. Clear suppression only after the provider record and recipient ownership are verified under an approved support procedure.
- Delivered and dead-lettered notification title/body and password-reset/webhook ciphertext are intentionally erased and cannot be reconstructed from the outbox.

## Password-Reset Alerts

- `PasswordResetEmailDeadLetters`: a new terminal transition occurred in the last 15 minutes. Inspect the retained dead-letter count and token-free worker diagnostics. Confirm whether the recipient lifecycle, suppression state, or provider request caused terminalization. Do not replay or reconstruct erased reset credentials; after the cause is resolved, the user must request a new reset. The alert resolves after 15 minutes without another terminal transition; historical rows remain available through the restricted operator path.
- `PasswordResetEmailProviderOutage`: the configured number of recent provider rejections has been reached and worker readiness is failing closed. Check Resend account/domain health and credential/configuration validity, then confirm the systemic-failure gauge clears after successful bounded sweeps. A single recipient rejection must not trigger this alert.
- `PasswordResetEmailSweepStale`: the enabled sweep is not running or its last successful cycle exceeds `PASSWORD_RESET_EMAIL_SWEEP_MAX_STALENESS_SECONDS`. Check worker logs, database reachability, and supervised task state; restart the worker only after preserving current outbox evidence and confirming the task cannot recover on its next interval.
## Staff-Invitation Alerts

Production requires `STAFF_INVITATION_OUTBOX_ENABLED=true`, a dedicated exact 32-byte `STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY`, `APP_ORIGIN`, `RESEND_API_KEY`, and `EMAIL_FROM` in both the API/worker launch contract as applicable. The worker healthcheck requires a running and ready sweep, no systemic provider failure, and a last successful cycle within `STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS`.

- `StaffInvitationDeadLetters`: a new terminal transition occurred in the last 15 minutes. Inspect only bounded status counts and opaque outbox IDs. Confirm whether recipient lifecycle, provider rejection, or envelope validation caused terminalization. Terminal payloads are erased and must not be reconstructed; after resolving the cause, use the supported tenant-scoped reissue route above. The alert resolves after 15 minutes without another terminal transition while audit history retains the replaced terminal identity and state.
- `StaffInvitationProviderOutage`: recent provider failures reached the bounded outage threshold and worker readiness is failing closed. Check Resend account/domain health and configuration, then confirm the systemic-failure gauge clears after a healthy sweep.
- `StaffInvitationSweepNotReady`: the supervised task is running but the latest non-systemic cycle failed. Check fixed-code worker logs, database reachability, and platform-admin capability; readiness must recover through a successful sweep rather than an operator override.
- `StaffInvitationSweepStale`: the enabled sweep has not completed a healthy cycle inside the freshness bound. Check worker task state, database reachability, and token-free logs before restarting; preserve terminal evidence and never reuse a terminal outbox identity for provider delivery.

## Notification Dead-Letter Alert

- `NotificationOutboxDeadLetters`: a new notification terminal transition occurred in the last 15 minutes. Triage by tenant-safe opaque IDs and retained status history; do not reconstruct erased title/body data. The alert resolves after 15 minutes without another terminal transition.
## Launch Verification

1. Send an OTP and password-reset email to a controlled inbox and confirm no secret-bearing application logs.
2. Replay the same password-reset outbox identity and confirm the provider does not create a second message.
3. Trigger a signed permanent-bounce fixture and confirm the matching active user is suppressed; confirm a transient bounce is ignored.
4. Publish a schedule twice with the same publication identity and confirm one notification intent per recipient.
5. Retry one tenant webhook delivery and confirm `X-LunchLineup-Delivery-Id` is unchanged.
6. Terminalize controlled notification, password-reset, and webhook rows and confirm their sensitive payload columns are blank.
7. Dead-letter a controlled staff invitation, reissue with one `Idempotency-Key`, and confirm the user ID is unchanged, the outbox/provider identity and ciphertext are new, the old terminal state is audited, and same-key response-loss replay does not create another action.
