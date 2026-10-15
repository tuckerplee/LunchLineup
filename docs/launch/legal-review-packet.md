# Legal review packet

For the business owner and counsel. Nothing here grants approval; it lists exactly what must be filled in and approved
before LunchLineup may leave `closed_beta` or take paid production traffic.

## Where legal values live (one source)

| What | File | Notes |
| --- | --- | --- |
| Business values and the approval switch | `packages/config/legal-launch.json` | Single source for the Terms, Privacy and Subprocessors pages, the API/web signup gate and the production env checker. |
| Public contact mailboxes | `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, `NEXT_PUBLIC_DPA_CONTACT_EMAIL` | Build-time env, compiled into the web image. Blank or `example` addresses render "contact pending owner signoff". |
| Paid-GA approval attestation | `PAID_GA_*` in the production runtime env | Must agree with `legal-launch.json`; checked by `scripts/check-production-env.mjs` and `scripts/validate-production-launch.mjs`. |
| Draft text | `apps/web/app/terms/page.tsx`, `privacy/page.tsx`, `subprocessors/page.tsx` | Counsel edits the wording here; bump the document `version`/`lastUpdated` in `legal-launch.json` when it changes. |

Until the owner completes this packet, the public pages say "Draft - not counsel approved", show "pending owner signoff"
for every unfilled value, and production is locked to `closed_beta`.

## A. Fill in `packages/config/legal-launch.json` (`business`)

| Field | Appears on | Owner supplies |
| --- | --- | --- |
| `legalEntityName` | Terms, Privacy | Exact registered entity name (also `PAID_GA_CONTRACTING_ENTITY`, must be identical). |
| `mailingAddress` | Terms, Privacy | Registered/notice mailing address. |
| `governingLaw` | Terms | Governing law and venue chosen with counsel. |
| `effectiveDate` | Terms, Privacy | `YYYY-MM-DD` the approved documents take effect (not later than launch). |

Any value that begins with `OWNER` is treated as unfilled.

## B. Fill in the contacts (build env)

`NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL`, `NEXT_PUBLIC_DPA_CONTACT_EMAIL`. Each must be a mailbox the owner actually monitors
(privacy and DPA requests are legal-deadline items). A single mailbox may serve privacy and DPA.

## C. Counsel review of the draft text

Counsel should confirm or edit, then record the approved version:

1. **Terms** (`/terms`, current version in `legal-launch.json`): service description, customer-data clause, billing and cancellation,
   acceptable use, availability and service changes, time-card disclaimer (records are operational, not payroll-final), suspension, support routing.
2. **Privacy** (`/privacy`): data categories, use, account lifecycle, retention (30-day application purge eligibility after a deletion request,
   35-day database backups, 90-day logs, seven-year billing/audit/payroll evidence, legal holds), request routing, subprocessor and DPA pointers.
   Confirm the retention numbers match what is actually deployed.
3. **Subprocessors** (`/subprocessors`): Stripe (billing) and Resend (email). Add any provider actually enabled (Cloudflare, backup object storage,
   identity provider, Turnstile) or confirm they are intentionally excluded as infrastructure.
4. **DPA**: a signable Data Processing Addendum does not exist in the repository. Counsel supplies it; the readiness notes are in `docs/compliance/dpa-readiness.md`.

Stale beta wording was removed from these pages in this change ("public beta", "Availability and Beta Changes"). The security
and status pages still describe themselves as beta in places and should be reviewed with the same pass.

## D. Paid-GA approval inputs (runtime env, from counsel)

| Variable | Meaning |
| --- | --- |
| `PAID_GA_LEGAL_APPROVED` | `true` only after real counsel sign-off. |
| `PAID_GA_CONTRACTING_ENTITY` | Identical to `business.legalEntityName`. |
| `PAID_GA_TERMS_VERSION` | Identical to `documents.terms.version`. |
| `PAID_GA_DPA_VERSION` | Version label of the approved DPA. |
| `PAID_GA_COUNSEL_APPROVAL_OWNER` | Named approver. |
| `PAID_GA_COUNSEL_APPROVED_AT` | Actual approval date `YYYY-MM-DD`, not in the future. |
| `PAID_GA_INCIDENT_NOTICE_HOURS` | Customer incident-notice commitment, 1 to 168. |
| `PAID_GA_SIGNATURE_PROCESS` | How DPAs are executed (for example countersigned workflow). |
| `PAID_GA_TRANSFER_TERMS` | International transfer mechanism (for example standard contractual clauses). |
| `PAID_GA_CONTACT_OWNER_EMAIL` | Mailbox that owns legal correspondence. |
| `PAID_GA_APPROVAL_RECORD_URI` | Immutable, dated JSON record of the approval (not a `latest` link). |

The `C13-*` rows of `docs/compliance/owner-input-register.md` (C13-CONTACTS, C13-LEGAL, C13-TERMS, C13-SIGNUP, C13-VENDORS, C13-RETENTION-POLICY) track the same inputs with evidence requirements.

## E. The approval switch (single flip)

After counsel approves the final text and the values above are in place, edit `packages/config/legal-launch.json`:

```
"approval": {
    "approved": true,
    "approvedBy": "<name>",
    "approvedAt": "YYYY-MM-DD",
    "termsVersion": "<same as documents.terms.version>",
    "privacyVersion": "<same as documents.privacy.version>"
}
```

If a version string differs from the document version, or `approved` is false, every consumer stays closed
(`hasCurrentSelfServiceLegalApproval()` returns false, the API refuses `invite_only`/`open` at startup, the web forces `closed_beta`).
Any later text change must bump the version and re-approve. Then rebuild the web image and run
`node scripts/check-production-env.mjs <runtime.env>`.

Section E is required for every production launch, including `closed_beta`: `scripts/check-production-env.mjs` requires `PAID_GA_LEGAL_APPROVED=true` to be backed by `approval.approved` in `legal-launch.json`.
