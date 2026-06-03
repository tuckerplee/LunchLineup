# API lunch-breaks

## Files

- `README.md`: this lunch-breaks folder guide.
- `lunch-breaks.controller.ts`: authenticated lunch/break policy, list, generation, setup, and edit endpoints.
- `lunch-breaks.module.ts`: Nest module wiring for lunch/break services.
- `lunch-breaks.service.ts`: tenant-scoped lunch/break policy, generation, persistence, and shift mapping logic.
- `lunch-breaks.service.spec.ts`: focused tests for standalone generation, shared schedule generation, persisted break mapping, and manual edits.

## Notes

Shared schedule reads and persisted lunch/break actions only operate on open shifts, managers, and staff. Admins and super admins are excluded from scheduler/lunch-break assignment surfaces even when their accounts exist in the tenant.
