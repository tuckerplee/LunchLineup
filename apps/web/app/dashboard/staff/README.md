# Staff workspace

Tenant staff and role-management UI.

## Files

- `README.md`: this staff workspace folder guide.
- `page.tsx`: permission-gated server route that supplies separate invitation, destructive-administration, role-reading, role-assignment, and role-management capabilities.
- `StaffSchedulingProfileEditor.tsx`: manager-facing skill and weekly-availability editor with fail-closed profile hydration and retry, independently recoverable optional location labels, explicit unconfigured state, overnight windows, and atomic profile saves.
- `StaffWorkspace.tsx`: staff directory and default-role invitation UI that conditionally loads the role catalog, opens scheduling-profile management for staff writers, separates assignment from role-definition controls, and provides admin-only PIN reset/removal confirmations.
- `role-deletion-confirmation.ts`: exact-name custom-role deletion contract with assignment-count blocking.
- `staff-action-confirmation.ts`: copy contract for explicit PIN-reset and staff-removal confirmations.
