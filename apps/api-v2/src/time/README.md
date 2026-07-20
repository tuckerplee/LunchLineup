# API v2 Time Cards

## Files

- `README.md`: this module guide.
- `pagination.ts`: opaque public-ID cursors and UTC input validation.
- `payroll.ts`: direct payroll-period assignment, lock ordering, and cutoff checks.
- `routes.ts`: Fastify/OpenAPI registration for all six native Time resources.
- `serialization.ts`: internal database rows to public time-card and break records.
- `time-cards.service.ts`: native tenant-RLS lifecycle owner with billing, idempotency, correction, audit, and recovery rules.
- `validation.ts`: time-card write, correction, audit, and overlap validation helpers.
- `validation.test.ts`: cursor, correction-window, and public serialization regression coverage.

This module owns the API-02 Time Card surface directly. It accepts and returns only public UUIDs, retains durable v1-compatible clock-in operation identities during cutover, and never calls the retained application bridge. Reads and corrections require paid entitlement; an existing open time card may always be recovered and clocked out.
