# Payroll Dashboard

Manager payroll workflow at `/dashboard/payroll`. Route and navigation access require only `payroll:read`; each command is independently hidden unless its exact permission is present.

## Files

- `README.md` - This payroll route inventory and forward-only workflow boundary.
- `page.tsx` - Server-side `payroll:read` gate and exact command capability projection.
- `PayrollWorkspace.tsx` - Compact policy history, period selection/creation, status, and source-of-truth composition.
- `PayrollPolicyForm.tsx` - Immutable policy timeline with confirmation-only reset; historical version-1 setup plus fixed-timezone, dual-aligned future versions.
- `PayrollPeriodDetail.tsx` - Exact-permission OPEN adoption, REVIEW decisions, terminal lock, bounded evidence, paid export, and amendment composition.
- `PayrollAmendments.tsx` - Work-timezone post-lock corrections with confirmation-only reset, future-period bounds, signed deltas, and requester/employee decision separation.
- `PayrollReconciliation.tsx` - Signed provider totals, rejected/all-accepted correction, bounded line pages, partial states, and exact-request replay.
- `payroll-api.ts` - Typed session/CSRF transport for payroll, bounded export-line reads, and the payroll-scoped export entitlement.
- `payroll-amendment-time.ts` - DST-safe locked-entry work-timezone rendering and datetime-local conversion.
- `payroll-attempt.ts` - User-bound session Idempotency-Key recovery using SHA-256 scope/payload digests, legacy local-storage purge, and memory-only reconciliation replay.
- `payroll-contract.ts` - Pure policy, zero-entry lifecycle readiness/export guard, paging, stale recovery, authoritative export eligibility/reason, terminal-state, amendment, and reconciliation-correction helpers.
- `payroll-normalize.ts` - Canonicalizes direct service envelopes, summary/card pages, evidence, amendments, and batch state for the UI.
- `payroll-paths.ts` - Pure bounded and encoded policy, period, card, and export-line pagination URL builders.
- `payroll-types.ts` - Immutable policy, period, card, locked-entry, amendment, deterministic batch, and line evidence types.
- `payroll.module.css` - Compact responsive table, form, status, focus, confirmation, and evidence styles down to 375px.
- `use-payroll-workspace.ts` - Bounded loading, session/user cleanup, exact digest-bound policy/amendment payload replay after ambiguous readback, export settlement, and memory-only reconciliation replay.

## Forward-only boundary

Version 1 may establish an aligned historical payroll boundary. Later immutable versions retain the version-1 timezone and use a future effective date aligned to both the prior and incoming cadence anchors. Periods move only `OPEN -> REVIEW -> LOCKED`; the lock is terminal. Ended empty periods may complete that lifecycle, but a zero-entry terminal snapshot cannot be exported. Review readiness always comes from server aggregates, while bounded card pages exist only for explicit loaded-row commands capped at 100.

Locked entries and their canonical evidence never change. Corrections use the locked entry work timezone, are assigned only to a qualifying future OPEN period, show signed minute deltas, and separate the requester/source employee from the approver. Policy and amendment forms clear only after a successful response or exact authoritative readback; an ambiguous `503` plus inconclusive readback preserves every field and the same payload-bound idempotency key for an identical replay. Exports honor authoritative `eligible=false` and show its bounded reason without issuing a POST; eligible exports read a positive authoritative credit cost from `GET /payroll/export-entitlement`, send it as `expectedCreditCost`, and retain one session-scoped key bound to SHA-256 user, scope, and payload digests. Downloading an existing batch is free. Raw payroll payloads never enter browser storage.

A locked or exported batch is not payroll-final. External payroll remains authoritative until every deterministic export line is accepted and signed provider total minutes exactly match the batch. Export lines load in explicit bounded pages; reconciliation records up to 500 explicitly loaded outcomes per request, permits rejected-to-accepted correction, and keeps accepted lines editable while an all-accepted provider total is still wrong. Ambiguous transport retains the exact payload only in memory for same-view replay. Payroll session metadata is cleared on route exit, sign-out, and account change.
