# Payroll Web Unit Tests

## Files

- `README.md` - This focused payroll test inventory.
- `payroll-api-contract.test.ts` - Bounded card/line endpoints, forward-state, exact policy/amendment form replay after ambiguous readback, expected-cost payload/key, and zero reverse-transition contracts.
- `payroll-amendment-time.test.ts` - Locked-entry timezone round trips plus nonexistent and ambiguous DST rejection.
- `payroll-attempt.test.ts` - SHA-256-bound session keys, legacy local-storage purge, raw-marker exclusion, user isolation, logout cleanup, and memory-only reconciliation replay.
- `payroll-navigation.test.ts` - `payroll:read` navigation, policy-write adoption/creation, and independent amendment create/decision combinations.
- `payroll-normalize.test.ts` - Direct policy, period/card page, and deterministic export-line cursor normalization.
- `payroll-responsive-accessibility.test.ts` - 375px tables, policy boundaries, focus, terminal/zero-entry states, signed correctable-line paging, timezone/separation, and icon contracts.
- `payroll-state.test.ts` - Initial/later policy boundaries, aggregate/empty readiness, terminal export guard, authoritative subscription/separate-credit ineligibility reasons, bounded row/line merge, signed totals, rejected/all-accepted correction, and reconciliation completeness.
