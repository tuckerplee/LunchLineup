# Staff workspace

Tenant staff and role-management UI.

## Files

- `AvailabilityPdfImport.tsx`: manager-visible required employee-identity input with username/email suggestion, strict scheduling-cost preflight, fail-closed stable-attempt upload, bounded status polling, authoritative settlement display, parsed-availability review, and explicit apply UI.
- `availability-pdf-import.ts`: required public employee-identity normalization, identity-bound stable attempt creation, PDF limits, strict scheduling-cost and server-settlement parsing, accepted-cost matching, and terminal refund-proof copy.
- `InvitationDeliveryStatus.tsx`: accessible queued/sending/delivered/failure status display with server-gated retry, dead-letter reissue, and manual refresh controls.
- `invitation-delivery.ts`: strict public invitation-delivery response parsing, PII-free view states, terminal retry/reissue policy, date labels, and stable recovery-key reuse.
- `README.md`: this staff workspace folder guide.
- `page.tsx`: permission-gated server route that supplies separate invitation, destructive-administration, role-reading, role-assignment, and role-management capabilities.
- `StaffSchedulingProfileEditor.tsx`: manager-facing scheduling-profile editor that suggests a visible username or email identifier for PDF import, with fail-closed hydration, the existing atomic profile save path, bounded location labels, preserved unavailable assignments, overnight windows, and manual editing.
- `StaffWorkspace.tsx`: responsive staff directory with paginated invitation delivery status, bounded status-request concurrency, stable idempotent retry/reissue attempts, a mobile-safe invitation form/table, role catalog/profile management, separate assignment controls, and admin-only PIN reset/removal confirmations.
- `use-invitation-delivery.ts`: invitation status hydration, bounded active-state polling, manual refresh, duplicate-click exclusion, and session-stable idempotent retry/dead-letter reissue orchestration.
- `role-deletion-confirmation.ts`: exact-name custom-role deletion contract with assignment-count blocking.
- `staff-action-confirmation.ts`: copy contract for explicit PIN-reset and staff-removal confirmations.
