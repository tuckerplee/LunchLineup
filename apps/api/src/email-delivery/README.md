# Email Delivery

- `README.md`: this email-delivery folder guide.
- `email-delivery-feedback.controller.ts`: public raw-body endpoint for signed Resend delivery feedback.
- `email-delivery-feedback.controller.spec.ts`: raw-body and fail-closed controller contracts.
- `email-delivery-feedback.service.ts`: signature verification, permanent bounce/complaint/suppression classification, recipient-state updates, and delivery policy checks.
- `email-delivery-feedback.service.spec.ts`: provider verification, idempotent status update, transient event, and suppression policy tests.
- `email-delivery.module.ts`: Nest module wiring for delivery feedback, policy checks, and schedule-publication email.
- `schedule-published-email.service.spec.ts`: fail-closed configuration, suppression, bounded delivery, HTML escaping, provider idempotency, and redacted diagnostics tests.
- `schedule-published-email.service.ts`: opt-in Resend delivery for published schedules with a single suppression/provider deadline and stable notification-outbox idempotency.
