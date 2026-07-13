# Subprocessors

This document is the source checklist for the public `/subprocessors` page. Keep it aligned with `apps/web/app/legal-config.ts` before public launch.

## Public Beta Subprocessors

| Provider | Purpose | Customer data | Location | Notes |
| --- | --- | --- | --- | --- |
| Stripe | Subscription billing, checkout, invoices, and payment processing. | Billing contact details, subscription state, invoice metadata, payment metadata, and Stripe customer identifiers. | United States and other Stripe processing locations. | Used when paid billing is enabled for a workspace. |
| Resend | Transactional email delivery for login OTPs, account notices, and service emails. | Recipient email address, sender address, message metadata, and the email body required to deliver the message. | United States and other Resend processing locations. | Required for production email delivery outside local development. |

## Not Listed as External Subprocessors

- LunchLineup-operated databases, queues, observability services, and backups are internal production infrastructure unless production is reconfigured to use a third-party managed provider.
- Customer-configured identity providers receive authentication data only when a workspace enables that provider.

## Launch Maintenance

- Set `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, and `NEXT_PUBLIC_DPA_CONTACT_EMAIL` to monitored, owner-approved production addresses before publishing this page as production subprocessor notice.
- Record owner signoff for the listed vendors, contact routing, and DPA request path before treating the page as customer-ready production copy.
- Review this list whenever billing, email, hosting, observability, analytics, support, or identity-provider vendors change.
- Update `/subprocessors`, this file, and `docs/compliance/privacy-security.md` in the same change when a subprocessor is added or removed.
