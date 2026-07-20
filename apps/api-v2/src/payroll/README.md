# Native Payroll API owner

`domain.ts` contains deterministic payroll policy, period, snapshot, CSV, hash,
locking, idempotency, and reconciliation primitives. `payroll.service.ts` is the
tenant-RLS PostgreSQL owner for the Payroll API-02 surface. `routes.ts` binds the
public API-v2 contract to that owner with native authentication, authorization,
CSRF, and cache controls.

All browser-facing identifiers in this folder are opaque public UUIDs. Internal
database IDs remain inside tenant transactions and immutable payroll evidence.
No file in this folder calls the retained application bridge.

## Files

- `README.md`: this payroll-module guide.
- `domain.ts`: deterministic payroll policy, evidence, export, and reconciliation primitives.
- `payroll.service.ts`: tenant-RLS PostgreSQL owner for the native payroll surface.
- `routes.ts`: authenticated API-v2 route bindings.
