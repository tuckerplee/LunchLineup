# Dashboard time-cards

## Files

- `README.md`: this time-cards route guide.
- `page.tsx`: server route that requires `time_cards:read` and passes independent time-card, staff-roster, and location-catalog capabilities to the client workspace.
- `TimeCardCorrectionPanel.tsx`: manager correction form for location-local punches, explicit break intervals, DST ambiguity selection, required reasons, and optimistic updates.
- `TimeCardHistory.tsx`: extracted bounded history table, correction selection, and explicit earlier-record continuation presentation.
- `TimeCardsWorkspace.tsx`: client time clock UI with separate signed-in My Time and explicit person/location Team Time contexts, bounded staff/location continuation, timezone-correct history, named clock mutations, active status, and manager correction selection.
- `time-card-api.ts`: session-authenticated bounded roster/location/history reads, cursor validation, and CSRF-protected clock/correction write helpers.
- `time-card-format.ts`: duration, IANA timezone display, location-local input, and repeated-hour candidate helpers.
- `time-card-types.ts`: shared client response types for time cards, locations, and persisted break intervals.
- `time-card-request.ts`: selected-employee ownership guard, explicit clock-in target policy, target-aware mutation labels, and durable request-key owner.

## Notes

History loads in 100-row cursor pages and exposes a Load earlier records action until the API returns no next cursor, so long-lived tenant histories stay bounded without hiding older records. Manager staff selection follows every bounded roster page before sorting, so the API cap does not hide eligible employees.

The UI relies on the API for tenant and role enforcement. My Time always stays bound to the signed-in user and never sends a delegated user ID. Team Time is separate and starts without a selected person or location; it cannot clock anyone in until both are chosen. The selected person remains visible above the form, and clock buttons plus success confirmations name the person and location. Person changes clear location, notes, break minutes, correction drafts, loaded cards, notices, and the clock-in request key before the next context loads. Location changes clear location-dependent notes, break minutes, correction drafts, notices, and the request key. Team selection requires both `users:read` and the roster endpoint's `shifts:read`; the location selector requires `locations:read`. Time-card history remains available without either optional catalog, and clock-in and clock-out controls require `time_cards:write`. If entitlement is lost while a card is open, the workspace keeps the active-card recovery result, disables history and new clock-ins, and leaves current-user clock-out available. A Team Time clock-out additionally requires the explicitly selected location to match the open card when the location catalog is available. Punches always render with the API-provided location IANA timezone (UTC for locationless legacy cards), never the browser timezone. Team managers with `time_cards:write` can correct punch and break intervals; skipped DST times fail and repeated times require explicit occurrence selection. The workspace labels these as operational records and directs customers to keep payroll systems authoritative until approval/locking, pay-period policy, and payroll export reconciliation exist.

Location options load one bounded page at a time and expose Load more locations only when the API returns a valid opaque continuation cursor. The client never auto-drains location pages.
