# Lunch and breaks route

## Files

- `README.md`: this route guide.
- `lunch-break-scope.ts`: selected-location/day matching used to reject stale planner responses and writes.
- `lunch-break-time.ts`: location-timezone day-window, wall-clock, overnight-shift, and display helpers.
- `page.tsx`: lunch and break planner for tenant-scoped schedule rows.

## Notes

`page.tsx` requires both `lunch_breaks:read` and `locations:read` plus an explicit tenant location, scopes lunch/break reads, setup-shift writes, row edits, and persisted generation to that location, and converts selected dates and wall-clock times with its IANA timezone. Navigation, proxy enforcement, and page bootstrap share the same two-permission prerequisite. Responses are accepted only while their location/day scope matches the active selection, and shift writes remain disabled until that scope has loaded. Manual planning starts empty and requires explicit user-entered rows; it does not seed local dummy staff. Scheduled-day and manual generation each retain one payload-bound `Idempotency-Key` until the complete client workflow succeeds, so authentication refreshes and response-loss retries reuse the original billing and generation outcome.
