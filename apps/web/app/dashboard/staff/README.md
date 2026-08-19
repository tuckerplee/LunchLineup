# Staff workspace

Tenant staff and role-management UI.

## Files

- `AddTeamMemberForm.tsx`: explicit email-invitation versus username/PIN onboarding flow with fail-closed delivery availability, method-specific fields and actions, generated/manual PIN entry, clipboard support, and mandatory temporary-credential acknowledgement.
- `AvailabilityPdfImport.tsx`: manager-visible required employee-identity input with username/email suggestion, strict scheduling-cost preflight, fail-closed stable-attempt upload, bounded status polling, authoritative settlement display, parsed-availability review, and explicit apply UI.
- `availability-pdf-import.ts`: required public employee-identity normalization, identity-bound stable attempt creation, PDF limits, strict scheduling-cost and server-settlement parsing, accepted-cost matching, and terminal refund-proof copy.
- `InvitationDeliveryStatus.tsx`: accessible queued/sending/delivered/failure status display with server-gated retry, dead-letter reissue, and manual refresh controls.
- `invitation-delivery.ts`: strict public invitation-delivery response parsing, PII-free view states, terminal retry/reissue policy, date labels, and stable recovery-key reuse.
- `README.md`: this staff workspace folder guide.
- `page.tsx`: permission-gated server route that supplies separate invitation, destructive-administration, role-reading, role-assignment, and role-management capabilities plus the non-secret staff-email readiness signal.
- `StaffSchedulingProfileEditor.tsx`: manager-facing scheduling-profile editor that suggests a visible username or email identifier for PDF import, with fail-closed hydration, one atomic profile save path, bounded location labels, preserved unavailable assignments, recurring overnight windows, and location-aware dated availability/time-off editing with explicit precedence copy.
- `StaffWorkspace.tsx`: responsive staff directory with paginated invitation delivery status, bounded status-request concurrency, stable idempotent retry/reissue attempts, staged role Save/Cancel controls with local feedback, role catalog/profile management, and admin-only PIN reset/removal confirmations.
- `staff-onboarding.ts`: pure email-readiness normalization, method-specific invitation payload shaping, unbiased cryptographic temporary-PIN generation, and role-selection comparison helpers.
- `use-invitation-delivery.ts`: invitation status hydration, bounded active-state polling, manual refresh, duplicate-click exclusion, and session-stable idempotent retry/dead-letter reissue orchestration.
- `role-deletion-confirmation.ts`: exact-name custom-role deletion contract with assignment-count blocking.
- `staff-action-confirmation.ts`: copy contract for explicit PIN-reset and staff-removal confirmations.
