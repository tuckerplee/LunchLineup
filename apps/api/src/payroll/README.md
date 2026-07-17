# API payroll

## Files

- `README.md`: this immutable payroll control-plane guide and sibling-file inventory.
- `payroll-amendment.service.ts`: serialization-retried forward-only signed amendment creation and separated append-only decisions.
- `payroll-card.service.ts`: serialization-retried optimistic historical adoption and exact append-only card decision orchestration.
- `payroll-csv.spec.ts`: deterministic LF CSV, positive sub-minute, signed-minute, and content-hash tests.
- `payroll-csv.ts`: deterministic UTF-8/LF export rendering, positive sub-minute handling, and line/content integrity hashes.
- `payroll-export.service.spec.ts`: exact-cost billing, authoritative eligibility reasons, separate subscription/credit denial, tenant-before-advisory lock order, cost-change replay, zero-line rejection, and lock-evidence tamper tests.
- `payroll-export.service.ts`: tenant-first, serialization-retried creation of one canonical exact-cost export batch per nonempty locked period and verified download recovery.
- `payroll-idempotency.spec.ts`: canonical request identity, replay-key, and drift-hash tests.
- `payroll-idempotency.ts`: actor/tenant/operation-bound request hashing and deterministic opaque export IDs.
- `payroll-lock-snapshot.spec.ts`: deterministic terminal entry ordering, per-entry hashes, aggregate hash, and signed-total tests.
- `payroll-lock-snapshot.ts`: pure locked-entry snapshot plus independently recomputable aggregate evidence.
- `payroll-lock.service.spec.ts`: serialization retry plus deterministic terminal locking of ended zero-entry periods with one audit.
- `payroll-lock.service.ts`: serialization-retried terminal REVIEW-to-LOCKED orchestration over ordered card, break, approval, and amendment evidence.
- `payroll-orchestration.spec.ts`: policy replay, period replay, serialization-retried ADOPT/review identity, review preflight, and forward amendment tests.
- `payroll-operation.ts`: compact validated `PayrollOperation` replay and response storage helpers.
- `payroll-period-cards.spec.ts`: shared review/lock blocker, positive sub-minute admission, and historical adoption-window classification tests.
- `payroll-period-cards.ts`: ordered candidate card locks and one shared forward-only review/terminal-lock preflight.
- `payroll-period.service.ts`: bounded period listing, effective-policy creation, and forward-only review transition.
- `payroll-period-summary.ts`: one-query authoritative readiness summaries for single and bounded period pages.
- `payroll-policy.service.ts`: bounded immutable policy history and replay-safe version creation.
- `payroll-policy.spec.ts`: calendar alignment, future-effective policy, and 23/25-hour DST boundary tests.
- `payroll-policy.ts`: pure immutable policy, local-date, anchor, cadence, and DST-correct period-boundary policy.
- `payroll-read.service.spec.ts`: adoption candidates, exact decisions, adjustment source employees, locked/reconciled detail, public hashes, and line-501 pagination tests.
- `payroll-read.service.ts`: bounded payroll detail read models, source-employee joins, authoritative summaries, and export-line cursor pages.
- `payroll-reconciliation.service.spec.ts`: provider-event dedupe/drift, rejected-to-accepted and wrong-total correction, and accumulated line-501 terminal completion tests.
- `payroll-reconciliation.service.ts`: immutable reconciliation receipts/events and bounded current line-state orchestration.
- `payroll-reconciliation.spec.ts`: bounded canonical reconciliation payload and digest tests.
- `payroll-reconciliation.ts`: pure reconciliation validation, canonical digest, and outcome counts.
- `payroll-records.ts`: public serializers exposing operator integrity hashes while hiding operation/request identities.
- `payroll-transaction.ts`: fixed diagnostics, bounded two-attempt serializable mutation replay for Prisma `P2034`/PostgreSQL `40001`, advisory locks, and audit helpers.
- `payroll-validation.spec.ts`: bounded adoption, decision, amendment, revision, pagination, and separation input tests.
- `payroll-validation.ts`: pure bounded request parsing for payroll control actions.
- `payroll.controller.spec.ts`: route permission metadata, delegation, and CSV attachment header tests.
- `payroll.controller.ts`: thin versioned HTTP routing and explicit payroll permission metadata.
- `payroll.module.ts`: NestJS payroll controller/service registration and billing dependency wiring.

## Contract

Payroll policies, approvals, locked entries, amendments, export lines, and reconciliation receipts are append-only evidence. The first policy version may use an aligned historical effective boundary so migrated cards can be periodized; later versions must be future-effective, retain the original timezone, and align under both the previous and incoming anchor/cadence. OPEN detail pages include bounded unassigned closed in-window history for explicit optimistic adoption. Review preflight and terminal locking share the same full-window blocker policy so the forward-only workflow cannot enter REVIEW with unresolved cards. Review decisions bind an exact card revision. Terminal locking snapshots approved cards plus approved amendments with deterministic signed totals; ended empty periods lock with zero count/minutes and deterministic aggregate evidence. There is no reopen or unlock API.

All control and recovery actions are unmetered. `GET /payroll/export-entitlement` exposes current export eligibility, its authoritative denial reason, and the authoritative `time_cards` credit cost to `payroll:export` operators. Export generation alone requires the active paid `time_cards` entitlement plus separate credits and an exact positive caller-confirmed `expectedCreditCost`; it verifies stored lock aggregate evidence before atomically debiting that cost and writing the canonical nonempty batch plus every line. Exact committed replay bypasses current entitlement/cost checks. Downloads rebuild LF CSV solely from immutable export lines and verify both line and content hashes before serving.

Clock-in, correction, and export share one lock hierarchy: the `Tenant` row, tenant payroll advisory lock, ordered period advisory locks, then period/card/break rows. Assigned card closure and correction reject a clock-out after the period cutoff; positive sub-minute closed cards remain valid zero-minute payroll evidence. Every payroll mutation retries once after Prisma `P2034` or PostgreSQL `40001` from a stale serializable snapshot; `40P01` is never a normal retry. Tenant/actor/request identities are computed once outside the retry, so exact replay retains one operation marker, domain write set, settlement where applicable, and audit.

`GET /payroll/periods/:id` returns the UI-ready period, bounded card page, locked entries, source amendments with decisions and tenant-bounded `sourceEmployeeId` evidence (including adjustment-period views), and the first bounded immutable export-line page. `GET /payroll/exports/:id?lineLimit=500&lineCursor=...` reaches subsequent lines and returns current line states plus authoritative aggregate reconciliation counts and latest receipt metadata. Reconciliation mutations remain limited to 500 explicit outcomes, append receipt/events and current-state updates atomically, allow rejected lines and all-accepted wrong-total batches to be corrected through a later provider event, retain signed totals, and terminalize only when every accumulated line state is accepted and the provider total exactly matches the immutable batch total.
