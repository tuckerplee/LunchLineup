# Scheduling API v2

## Files

- `README.md`: this module guide.
- `board.service.ts`: one bounded tenant board query for locations, roster, schedules, and shifts.
- `change-set-plan.ts`: pure final-state planner and overlap validator.
- `change-set-plan.test.ts`: final-state swap, overlap, and operation-planning tests.
- `change-set.service.test.ts`: response-loss replay proof across refreshed board revisions.
- `change-set.service.ts`: serialized, idempotent, revision-fenced aggregate transaction.
- `contract-helpers.ts`: ETag, idempotency, canonical hashing, UTC parsing, and case-preserving shift-role validation.
- `demand-window.service.test.ts`: proof that v2 exposes only opaque UUID demand-window identifiers.
- `demand-window.service.ts`: native bounded demand reads and atomic revision-fenced replacement.
- `entitlement.ts`: zero-settlement scheduling entitlement check.
- `idempotency-replay.test.ts`: response-loss replay proof for demand replacement and schedule reopening.
- `legacy-scheduling.bridge.ts`: bounded public-ID translation for retained billing, notification, solver, and break-generation subsystems.
- `legacy-scheduling.bridge.test.ts`: proof that retained calls cannot leak internal scheduling identifiers through v2.
- `lifecycle.service.ts`: native idempotent published-schedule reopening.
- `routes.ts`: Fastify/OpenAPI route definitions.
- `schedule-create.service.ts`: explicit idempotent draft-schedule creation.
- `serialization.ts`: internal-to-public schedule and shift mapping.
- `time-zone.ts`: IANA-local board window conversion.

One change set can create, update, assign, move, or delete up to 100 shifts. It evaluates the final state, so a multi-shift swap is valid when its result has no overlap even if sequential row updates would temporarily overlap. Omitted update fields retain their exact saved values; supplied custom role labels are whitespace-trimmed but retain their casing.

The browser never calls the retained scheduling routes. Compatibility exists only inside `legacy-scheduling.bridge.ts` for operations whose billing, queue, or notification settlement still lives in v1.
