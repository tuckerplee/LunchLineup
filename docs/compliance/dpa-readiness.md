# DPA Readiness

This document records the public beta DPA posture. It is readiness wording, not a signed customer contract.

## Customer-Facing Position

LunchLineup can route Data Processing Addendum requests through `NEXT_PUBLIC_DPA_CONTACT_EMAIL`. DPA review should cover:

- Processing roles for LunchLineup and the customer workspace.
- The data categories listed in `privacy-security.md`.
- The subprocessor list in `subprocessors.md`.
- Retention, export, cancellation, deletion, and delayed retained-record expiry from `docs/runbooks/data-retention-delete-export.md`.
- Security commitments, incident notice, and transfer terms required by the customer relationship.

## Ready for Public Beta

- Public `/privacy`, `/security`, and `/subprocessors` pages can point customers to monitored privacy, support, and DPA contacts through owner-approved environment-backed values.
- Missing, invalid, or template-style public contact values are gated as pending owner signoff rather than rendered as customer email links.
- The account lifecycle runbook documents export, cancellation, deletion request, retained-record expiry, and backup/log retention limits.
- The public subprocessor list has a review path before vendor changes.

## Paid GA Legal Blockers

- Legal must approve the final DPA template, contracting entity, governing law, signature path, incident-notice window, and any required international transfer terms.
- Legal/support owners must sign off on the configured privacy, support, and DPA contact addresses before opening paid general availability.

## Fail-Closed Launch Gate

The production launch validator rejects paid GA until protected runtime configuration records all of the following:

- `PAID_GA_LEGAL_APPROVED=true`, the approved contracting entity, Terms version, and DPA version.
- Counsel approval owner and non-future approval date.
- Approved incident-notice hours, signature process, and transfer terms.
- A monitored contact-owner email.
- A specific retained JSON approval record URI, not a mutable `latest` reference.

These values are operational attestations, not substitutes for legal approval. The repository intentionally contains no approved entity or contract values; counsel and the named operational owner must supply them through the protected production environment.
