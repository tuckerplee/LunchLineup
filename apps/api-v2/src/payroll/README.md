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
- `payroll-current-authority.test.ts`: native payroll current-authority and financial replay regressions with staged database effects.
- `payroll-export-read-authority.test.ts`: populated native export read-authority, pagination and immutable-evidence regressions.
- `payroll-period-read-authority.spec.ts`: native period list/detail read-authority regressions preserving historical entries, cards and exports.
- `payroll-policy-read-authority.spec.ts`: native policy list/latest read-authority and cursor regressions with historical creator controls.
